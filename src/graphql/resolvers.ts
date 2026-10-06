import { DateTime } from "luxon";

import { prisma } from "../lib/prisma";

import {
    hashPassword,
    verifyPassword,
} from "../auth/password";

import { createToken } from "../auth/jwt";

import {
    requireAuth,
    requireRole,
} from "../auth/authorization";

import type { Context } from "../auth/context";

import {
    BUSINESS_TIMEZONE,
    calculateSlaDeadlines,
    calculateSLAState,
    calculateRemainingBusinessMinutes,
} from "../sla/sla";

import {
    AppError,
    ERROR_CODES,
} from "./errors";


// ============================================================
// TYPES
// ============================================================

type TicketPriority =
    | "LOW"
    | "MEDIUM"
    | "HIGH"
    | "URGENT";

type TicketStatus =
    | "OPEN"
    | "IN_PROGRESS"
    | "RESOLVED"
    | "CLOSED";

type SLAState =
    | "ON_TRACK"
    | "AT_RISK"
    | "BREACHED";

type UserRole =
    | "USER"
    | "AGENT"
    | "ADMIN";

type TicketFilter = {
    status?: TicketStatus;
    priority?: TicketPriority;
    assigneeId?: string;
    slaState?: SLAState;
};

type TicketQueryArgs = {
    filter?: TicketFilter;
    take?: number;
    cursor?: string;
};

type UserQueryArgs = {
    role?: UserRole;
};


// ============================================================
// PRISMA INCLUDE
// ============================================================

const ticketInclude = {
    creator: true,
    agent: true,
    comments: {
        include: {
            author: true,
        },
        orderBy: {
            createdAt: "asc" as const,
        },
    },
};


// ============================================================
// STATUS TRANSITIONS
// ============================================================

const ALLOWED_STATUS_TRANSITIONS: Record<
    TicketStatus,
    TicketStatus[]
> = {
    OPEN: ["IN_PROGRESS"],
    IN_PROGRESS: ["RESOLVED"],
    RESOLVED: ["CLOSED"],
    CLOSED: [],
};


function validateStatusTransition(
    current: TicketStatus,
    next: TicketStatus
): void {
    if (current === next) {
        return;
    }

    const allowed =
        ALLOWED_STATUS_TRANSITIONS[current];

    if (!allowed.includes(next)) {
        throw new AppError(
            `Ticket cannot transition from ${current} to ${next}.`,
            ERROR_CODES.INVALID_STATUS_TRANSITION
        );
    }
}


// ============================================================
// HOLIDAY HELPERS
// ============================================================

async function getHolidayKeys(): Promise<Set<string>> {
    const holidays =
        await prisma.holiday.findMany({
            select: {
                date: true,
            },
        });

    return new Set(
        holidays.map((holiday) =>
            DateTime.fromJSDate(
                holiday.date,
                {
                    zone: BUSINESS_TIMEZONE,
                }
            ).toISODate()!
        )
    );
}


// ============================================================
// CURSOR HELPERS
// ============================================================

function encodeCursor(id: string): string {
    return Buffer
        .from(id, "utf8")
        .toString("base64url");
}


function decodeCursor(cursor: string): string {
    try {
        return Buffer
            .from(cursor, "base64url")
            .toString("utf8");
    } catch {
        throw new AppError(
            "Invalid pagination cursor.",
            ERROR_CODES.VALIDATION_ERROR
        );
    }
}


// ============================================================
// SLA CALCULATION HELPER
// ============================================================

type TicketWithSla = {
    ticket: Awaited<
        ReturnType<
            typeof prisma.ticket.findUnique
        >
    >;
    firstResponseState: SLAState;
    resolutionState: SLAState;
};


async function calculateTicketSLA(
    ticket: {
        createdAt: Date;
        priority: TicketPriority;
        firstResponseDueAt: Date | null;
        resolutionDueAt: Date | null;
        firstResponseAt: Date | null;
        resolvedAt: Date | null;
    },
    holidays: Set<string>
) {
    let firstResponseDueAt = ticket.firstResponseDueAt;
    let resolutionDueAt = ticket.resolutionDueAt;

    // Older tickets may not have persisted SLA deadlines.
    // Calculate them from the ticket creation time if missing.
    if (!firstResponseDueAt || !resolutionDueAt) {
        const deadlines = calculateSlaDeadlines(
            ticket.createdAt,
            ticket.priority,
            holidays
        );

        firstResponseDueAt ??= deadlines.firstResponseDueAt;
        resolutionDueAt ??= deadlines.resolutionDueAt;
    }

    const now = new Date();

    return {
        firstResponseDueAt: firstResponseDueAt.toISOString(),

        resolutionDueAt: resolutionDueAt.toISOString(),

        firstResponseState: calculateSLAState(
            ticket.createdAt,
            firstResponseDueAt,
            ticket.firstResponseAt,
            now,
            holidays
        ),

        resolutionState: calculateSLAState(
            ticket.createdAt,
            resolutionDueAt,
            ticket.resolvedAt,
            now,
            holidays
        ),

        firstResponseRemainingMinutes:
            calculateRemainingBusinessMinutes(
                firstResponseDueAt,
                ticket.firstResponseAt,
                now,
                holidays
            ),

        resolutionRemainingMinutes:
            calculateRemainingBusinessMinutes(
                resolutionDueAt,
                ticket.resolvedAt,
                now,
                holidays
            ),
    };
}

function iso(value: Date | null | undefined): string | null {
    return value ? value.toISOString() : null;
}

// ============================================================
// RESOLVERS
// ============================================================

export const resolvers = {

    User: {
        createdAt: (user: { createdAt: Date }) => iso(user.createdAt),
    },

    Comment: {
        createdAt: (comment: { createdAt: Date }) => iso(comment.createdAt),
    },

    Holiday: {
        date: (holiday: { date: Date }) => iso(holiday.date),
        createdAt: (holiday: { createdAt: Date }) => iso(holiday.createdAt),
    },

    // ========================================================
    // TICKET
    // ========================================================

    Ticket: {

        createdAt: (t: { createdAt: Date }) => iso(t.createdAt),
        updatedAt: (t: { updatedAt: Date }) => iso(t.updatedAt),
        firstResponseAt: (t: { firstResponseAt: Date | null }) => iso(t.firstResponseAt),
        resolvedAt: (t: { resolvedAt: Date | null }) => iso(t.resolvedAt),

        firstResponseDueAt: async (
            ticket: {
                createdAt: Date;
                priority: TicketPriority;
                firstResponseDueAt: Date | null;
            }
        ) => {
            if (ticket.firstResponseDueAt) {
                return ticket.firstResponseDueAt.toISOString();
            }

            const holidays = await getHolidayKeys();

            const { firstResponseDueAt } =
                calculateSlaDeadlines(
                    ticket.createdAt,
                    ticket.priority,
                    holidays
                );

            return firstResponseDueAt.toISOString();
        },

        resolutionDueAt: async (
            ticket: {
                createdAt: Date;
                priority: TicketPriority;
                resolutionDueAt: Date | null;
            }
        ) => {
            if (ticket.resolutionDueAt) {
                return ticket.resolutionDueAt.toISOString();
            }

            const holidays = await getHolidayKeys();

            const { resolutionDueAt } =
                calculateSlaDeadlines(
                    ticket.createdAt,
                    ticket.priority,
                    holidays
                );

            return resolutionDueAt.toISOString();
        },

        sla: async (
            ticket: {
                createdAt: Date;
                priority: TicketPriority;
                firstResponseDueAt: Date | null;
                resolutionDueAt: Date | null;
                firstResponseAt: Date | null;
                resolvedAt: Date | null;
            }
        ) => {
            const holidays = await getHolidayKeys();

            let firstResponseDueAt = ticket.firstResponseDueAt;
            let resolutionDueAt = ticket.resolutionDueAt;

            // Support tickets created before SLA deadlines were persisted.
            if (!firstResponseDueAt || !resolutionDueAt) {
                const deadlines = calculateSlaDeadlines(
                    ticket.createdAt,
                    ticket.priority,
                    holidays
                );

                firstResponseDueAt ??= deadlines.firstResponseDueAt;
                resolutionDueAt ??= deadlines.resolutionDueAt;
            }

            const now = new Date();

            return {
                firstResponseDueAt: firstResponseDueAt.toISOString(),

                resolutionDueAt: resolutionDueAt.toISOString(),

                firstResponseState: calculateSLAState(
                    ticket.createdAt,
                    firstResponseDueAt,
                    ticket.firstResponseAt,
                    now,
                    holidays
                ),

                resolutionState: calculateSLAState(
                    ticket.createdAt,
                    resolutionDueAt,
                    ticket.resolvedAt,
                    now,
                    holidays
                ),

                firstResponseRemainingMinutes:
                    calculateRemainingBusinessMinutes(
                        firstResponseDueAt,
                        ticket.firstResponseAt,
                        now,
                        holidays
                    ),

                resolutionRemainingMinutes:
                    calculateRemainingBusinessMinutes(
                        resolutionDueAt,
                        ticket.resolvedAt,
                        now,
                        holidays
                    ),
            };
        },
    },


    // ========================================================
    // QUERY
    // ========================================================

    Query: {

        // ----------------------------------------------------
        // TICKETS
        // ----------------------------------------------------

        tickets: async (
            _: unknown,
            args: TicketQueryArgs,
            context: Context
        ) => {

            const user =
                requireAuth(context);

            const take =
                args.take ?? 10;

            if (
                !Number.isInteger(take) ||
                take < 1 ||
                take > 100
            ) {
                throw new AppError(
                    "take must be between 1 and 100.",
                    ERROR_CODES.VALIDATION_ERROR
                );
            }


            const filter =
                args.filter ?? {};


            // ------------------------------------------------
            // DATABASE FILTERS
            // ------------------------------------------------

            const where = {
                ...(user.role === "USER"
                    ? {
                        creatorId: user.id,
                    }
                    : {}),

                ...(filter.status
                    ? {
                        status: filter.status,
                    }
                    : {}),

                ...(filter.priority
                    ? {
                        priority: filter.priority,
                    }
                    : {}),

                ...(filter.assigneeId
                    ? {
                        agentId:
                            filter.assigneeId,
                    }
                    : {}),
            };


            /*
             * We intentionally don't put SLA state into
             * Prisma's WHERE clause because SLA state is
             * derived from the current time + business hours
             * + holidays.
             *
             * Therefore:
             *
             * PostgreSQL filtering
             *        ↓
             * SLA calculation
             *        ↓
             * SLA filtering
             *        ↓
             * cursor pagination
             */

            const tickets =
                await prisma.ticket.findMany({
                    where,
                    include: ticketInclude,
                    orderBy: [
                        {
                            createdAt: "desc",
                        },
                        {
                            id: "desc",
                        },
                    ],
                });


            const holidays =
                await getHolidayKeys();


            // ------------------------------------------------
            // SLA FILTER
            // ------------------------------------------------

            const filteredTickets =
                [];

            for (const ticket of tickets) {

                if (!filter.slaState) {
                    filteredTickets.push(
                        ticket
                    );

                    continue;
                }

                const sla =
                    await calculateTicketSLA(
                        ticket,
                        holidays
                    );

                const matches =
                    sla.firstResponseState ===
                    filter.slaState ||
                    sla.resolutionState ===
                    filter.slaState;

                if (matches) {
                    filteredTickets.push(
                        ticket
                    );
                }
            }


            // ------------------------------------------------
            // CURSOR
            // ------------------------------------------------

            let startIndex = 0;

            if (args.cursor) {

                const cursorId =
                    decodeCursor(
                        args.cursor
                    );

                const cursorIndex =
                    filteredTickets.findIndex(
                        (ticket) =>
                            ticket.id ===
                            cursorId
                    );

                if (cursorIndex === -1) {
                    throw new AppError(
                        "Invalid pagination cursor.",
                        ERROR_CODES.VALIDATION_ERROR
                    );
                }

                startIndex =
                    cursorIndex + 1;
            }


            // ------------------------------------------------
            // PAGINATE
            // ------------------------------------------------

            const nodes =
                filteredTickets.slice(
                    startIndex,
                    startIndex + take
                );

            const hasNextPage =
                startIndex + take <
                filteredTickets.length;

            const lastNode = nodes.at(-1);

            const endCursor = lastNode
                ? encodeCursor(lastNode.id)
                : null;


            return {
                nodes,
                pageInfo: {
                    hasNextPage,
                    endCursor,
                },
                totalCount:
                    filteredTickets.length,
            };
        },


        // ----------------------------------------------------
        // SINGLE TICKET
        // ----------------------------------------------------

        ticket: async (
            _: unknown,
            args: {
                id: string;
            },
            context: Context
        ) => {

            const user =
                requireAuth(context);

            const ticket =
                await prisma.ticket.findUnique({
                    where: {
                        id: args.id,
                    },
                    include: ticketInclude,
                });


            if (!ticket) {
                throw new AppError(
                    "Ticket not found.",
                    ERROR_CODES.TICKET_NOT_FOUND
                );
            }


            // USER → own tickets only

            if (
                user.role === "USER" &&
                ticket.creatorId !== user.id
            ) {
                throw new AppError(
                    "You are not allowed to view this ticket.",
                    ERROR_CODES.FORBIDDEN
                );
            }


            /*
             * AGENTS and ADMINS can view tickets.
             *
             * This is preferable to restricting an agent
             * only to tickets already assigned to them,
             * because agents need to see unassigned tickets
             * in order to manage the queue.
             */

            return ticket;
        },


        // ----------------------------------------------------
        // DASHBOARD
        // ----------------------------------------------------

        dashboard: async (
            _: unknown,
            __: unknown,
            context: Context
        ) => {

            const user =
                requireAuth(context);

            const where =
                user.role === "USER"
                    ? {
                        creatorId: user.id,
                    }
                    : {};


            const tickets =
                await prisma.ticket.findMany({
                    where,
                    select: {
                        status: true,
                        priority: true,
                        createdAt: true,
                        firstResponseDueAt: true,
                        resolutionDueAt: true,
                        firstResponseAt: true,
                        resolvedAt: true,
                    },
                });


            const holidays =
                await getHolidayKeys();


            let openTickets = 0;
            let inProgressTickets = 0;
            let atRiskTickets = 0;
            let breachedTickets = 0;


            for (const ticket of tickets) {

                if (
                    ticket.status ===
                    "OPEN"
                ) {
                    openTickets++;
                }

                if (
                    ticket.status ===
                    "IN_PROGRESS"
                ) {
                    inProgressTickets++;
                }


                const sla =
                    await calculateTicketSLA(
                        ticket,
                        holidays
                    );


                if (
                    sla.firstResponseState ===
                    "AT_RISK" ||
                    sla.resolutionState ===
                    "AT_RISK"
                ) {
                    atRiskTickets++;
                }


                if (
                    sla.firstResponseState ===
                    "BREACHED" ||
                    sla.resolutionState ===
                    "BREACHED"
                ) {
                    breachedTickets++;
                }
            }


            return {
                openTickets,
                inProgressTickets,
                atRiskTickets,
                breachedTickets,
            };
        },


        // ----------------------------------------------------
        // USERS
        // ----------------------------------------------------

        users: async (
            _: unknown,
            args: UserQueryArgs,
            context: Context
        ) => {

            requireRole(context, ["ADMIN"]);

            return prisma.user.findMany({
                where: args.role
                    ? {
                        role: args.role,
                    }
                    : undefined,

                orderBy: {
                    name: "asc",
                },
            });
        },


        // ----------------------------------------------------
        // AGENTS
        // ----------------------------------------------------

        agents: async (
            _: unknown,
            __: unknown,
            context: Context
        ) => {

            requireRole(
                context,
                ["AGENT", "ADMIN"]
            );

            return prisma.user.findMany({
                where: {
                    role: "AGENT",
                },
                orderBy: {
                    name: "asc",
                },
            });
        },


        // ----------------------------------------------------
        // HOLIDAYS
        // ----------------------------------------------------

        holidays: async (
            _: unknown,
            __: unknown,
            context: Context
        ) => {

            requireAuth(context);

            return prisma.holiday.findMany({
                orderBy: {
                    date: "asc",
                },
            });
        },


        // ----------------------------------------------------
        // CURRENT USER
        // ----------------------------------------------------

        me: async (
            _: unknown,
            __: unknown,
            context: Context
        ) => {

            return requireAuth(context);
        },
    },


    // ========================================================
    // MUTATIONS
    // ========================================================

    Mutation: {

        // ----------------------------------------------------
        // REGISTER
        // ----------------------------------------------------

        register: async (
            _: unknown,
            args: {
                name: string;
                email: string;
                password: string;
                role: UserRole;
            }
        ) => {

            const name =
                args.name.trim();

            const email =
                args.email.trim().toLowerCase();


            if (!name) {
                throw new AppError(
                    "Name cannot be empty.",
                    ERROR_CODES.VALIDATION_ERROR
                );
            }


            if (!email) {
                throw new AppError(
                    "Email cannot be empty.",
                    ERROR_CODES.VALIDATION_ERROR
                );
            }


            if (
                args.password.length < 6
            ) {
                throw new AppError(
                    "Password must be at least 6 characters.",
                    ERROR_CODES.VALIDATION_ERROR
                );
            }


            /*
             * Public registration must not allow
             * users to create ADMIN accounts.
             */

            if (args.role === "ADMIN") {
                throw new AppError(
                    "ADMIN accounts cannot be created through public registration.",
                    ERROR_CODES.FORBIDDEN
                );
            }


            const existingUser =
                await prisma.user.findUnique({
                    where: {
                        email,
                    },
                });


            if (existingUser) {
                throw new AppError(
                    "Email is already registered.",
                    ERROR_CODES.CONFLICT
                );
            }


            const passwordHash =
                await hashPassword(
                    args.password
                );


            const user =
                await prisma.user.create({
                    data: {
                        name,
                        email,
                        passwordHash,
                        role: "USER",
                    },
                });


            const token =
                await createToken(
                    user.id
                );


            return {
                token,
                user,
            };
        },


        // ----------------------------------------------------
        // LOGIN
        // ----------------------------------------------------

        login: async (
            _: unknown,
            args: {
                email: string;
                password: string;
            }
        ) => {

            const email =
                args.email
                    .trim()
                    .toLowerCase();


            const user =
                await prisma.user.findUnique({
                    where: {
                        email,
                    },
                });


            if (!user) {
                throw new AppError(
                    "Invalid email or password.",
                    ERROR_CODES.UNAUTHORIZED
                );
            }


            const validPassword =
                await verifyPassword(
                    args.password,
                    user.passwordHash
                );


            if (!validPassword) {
                throw new AppError(
                    "Invalid email or password.",
                    ERROR_CODES.UNAUTHORIZED
                );
            }


            const token =
                await createToken(
                    user.id
                );


            return {
                token,
                user,
            };
        },


        // ----------------------------------------------------
        // CREATE TICKET
        // ----------------------------------------------------

        createTicket: async (
            _: unknown,
            args: {
                title: string;
                description: string;
                priority: TicketPriority;
            },
            context: Context
        ) => {

            const user =
                requireAuth(context);


            const title =
                args.title.trim();

            const description =
                args.description.trim();


            if (!title) {
                throw new AppError(
                    "Ticket title cannot be empty.",
                    ERROR_CODES.VALIDATION_ERROR
                );
            }


            if (!description) {
                throw new AppError(
                    "Ticket description cannot be empty.",
                    ERROR_CODES.VALIDATION_ERROR
                );
            }


            const createdAt =
                new Date();


            const holidays =
                await getHolidayKeys();


            const {
                firstResponseDueAt,
                resolutionDueAt,
            } =
                calculateSlaDeadlines(
                    createdAt,
                    args.priority,
                    holidays
                );


            return prisma.ticket.create({
                data: {
                    title,
                    description,
                    priority: args.priority,

                    creatorId:
                        user.id,

                    firstResponseDueAt,
                    resolutionDueAt,

                    createdAt,
                },

                include: ticketInclude,
            });
        },


        // ----------------------------------------------------
        // ASSIGN TICKET
        // ----------------------------------------------------

        assignTicket: async (
            _: unknown,
            args: {
                ticketId: string;
                agentId: string;
            },
            context: Context
        ) => {

            const user =
                requireRole(
                    context,
                    ["AGENT", "ADMIN"]
                );


            const agent =
                await prisma.user.findUnique({
                    where: {
                        id: args.agentId,
                    },
                });


            if (!agent) {
                throw new AppError(
                    "Assignee not found.",
                    ERROR_CODES.USER_NOT_FOUND
                );
            }


            if (
                agent.role !== "AGENT"
            ) {
                throw new AppError(
                    "Selected user is not an agent.",
                    ERROR_CODES.VALIDATION_ERROR
                );
            }


            const ticket =
                await prisma.ticket.findUnique({
                    where: {
                        id: args.ticketId,
                    },
                });


            if (!ticket) {
                throw new AppError(
                    "Ticket not found.",
                    ERROR_CODES.TICKET_NOT_FOUND
                );
            }


            /*
             * An AGENT should not arbitrarily assign tickets
             * to another agent unless your permission model
             * explicitly allows it.
             *
             * ADMIN can assign freely.
             *
             * An agent can assign a ticket to themselves.
             */

            if (
                user.role === "AGENT" &&
                args.agentId !== user.id
            ) {
                throw new AppError(
                    "Agents can only assign tickets to themselves.",
                    ERROR_CODES.FORBIDDEN
                );
            }


            return prisma.ticket.update({
                where: {
                    id: ticket.id,
                },

                data: {
                    agentId:
                        args.agentId,
                },

                include: ticketInclude,
            });
        },


        // ----------------------------------------------------
        // CHANGE TICKET STATUS
        // ----------------------------------------------------

        changeTicketStatus: async (
            _: unknown,
            args: {
                ticketId: string;
                status: TicketStatus;
            },
            context: Context
        ) => {

            const user =
                requireRole(
                    context,
                    ["AGENT", "ADMIN"]
                );


            const ticket =
                await prisma.ticket.findUnique({
                    where: {
                        id: args.ticketId,
                    },
                });


            if (!ticket) {
                throw new AppError(
                    "Ticket not found.",
                    ERROR_CODES.TICKET_NOT_FOUND
                );
            }


            if (
                user.role === "AGENT" &&
                ticket.agentId !== user.id
            ) {
                throw new AppError(
                    "You are not allowed to update this ticket.",
                    ERROR_CODES.FORBIDDEN
                );
            }


            validateStatusTransition(
                ticket.status,
                args.status
            );

            const data: {
                status: TicketStatus;
                resolvedAt?: Date;
                firstResponseAt?: Date;
            } = {
                status: args.status,
            };

            const now = new Date();

            if (!ticket.firstResponseAt) {
                data.firstResponseAt = now;
            }

            if (args.status === "RESOLVED") {
                data.resolvedAt = ticket.resolvedAt ?? now;
            }

            return prisma.ticket.update({
                where: {
                    id: ticket.id,
                },

                data,

                include: ticketInclude,
            });
        },


        // ----------------------------------------------------
        // RESOLVE TICKET
        // ----------------------------------------------------

        resolveTicket: async (
            _: unknown,
            args: {
                ticketId: string;
            },
            context: Context
        ) => {

            const user =
                requireRole(
                    context,
                    ["AGENT", "ADMIN"]
                );


            const ticket =
                await prisma.ticket.findUnique({
                    where: {
                        id: args.ticketId,
                    },
                });


            if (!ticket) {
                throw new AppError(
                    "Ticket not found.",
                    ERROR_CODES.TICKET_NOT_FOUND
                );
            }


            if (
                user.role === "AGENT" &&
                ticket.agentId !== user.id
            ) {
                throw new AppError(
                    "You are not allowed to resolve this ticket.",
                    ERROR_CODES.FORBIDDEN
                );
            }


            validateStatusTransition(
                ticket.status,
                "RESOLVED"
            );


            const resolvedAt =
                new Date();


            return prisma.ticket.update({
                where: {
                    id: ticket.id,
                },

                data: {
                    status: "RESOLVED",
                    resolvedAt,
                    firstResponseAt: ticket.firstResponseAt ?? resolvedAt,
                },

                include: ticketInclude,
            });
        },


        // ----------------------------------------------------
        // ADD COMMENT
        // ----------------------------------------------------

        addComment: async (
            _: unknown,
            args: {
                ticketId: string;
                content: string;
            },
            context: Context
        ) => {

            const user =
                requireAuth(context);


            const content =
                args.content.trim();


            if (!content) {
                throw new AppError(
                    "Comment cannot be empty.",
                    ERROR_CODES.VALIDATION_ERROR
                );
            }


            const ticket =
                await prisma.ticket.findUnique({
                    where: {
                        id: args.ticketId,
                    },
                });


            if (!ticket) {
                throw new AppError(
                    "Ticket not found.",
                    ERROR_CODES.TICKET_NOT_FOUND
                );
            }


            // -----------------------------------------------
            // USER
            // -----------------------------------------------

            if (
                user.role === "USER" &&
                ticket.creatorId !== user.id
            ) {
                throw new AppError(
                    "You are not allowed to comment on this ticket.",
                    ERROR_CODES.FORBIDDEN
                );
            }


            // -----------------------------------------------
            // AGENT
            // -----------------------------------------------

            if (
                user.role === "AGENT" &&
                ticket.agentId !== user.id
            ) {
                throw new AppError(
                    "You are not allowed to comment on this ticket.",
                    ERROR_CODES.FORBIDDEN
                );
            }


            // -----------------------------------------------
            // CREATE COMMENT
            // -----------------------------------------------

            const comment =
                await prisma.comment.create({
                    data: {
                        content,
                        ticketId:
                            ticket.id,
                        authorId:
                            user.id,
                    },

                    include: {
                        author: true,
                    },
                });


            // -----------------------------------------------
            // FIRST RESPONSE
            // -----------------------------------------------

            /*
             * The first comment by someone other than
             * the reporter is the first response.
             *
             * updateMany with firstResponseAt = null
             * prevents a later comment from overwriting
             * the original response timestamp.
             */

            if (
                user.id !==
                ticket.creatorId &&
                !ticket.firstResponseAt
            ) {

                await prisma.ticket.updateMany({
                    where: {
                        id: ticket.id,
                        firstResponseAt: null,
                    },

                    data: {
                        firstResponseAt:
                            comment.createdAt,
                    },
                });
            }


            return comment;
        },


        // ----------------------------------------------------
        // UPDATE USER ROLE
        // ----------------------------------------------------

        updateUserRole: async (
            _: unknown,
            args: {
                userId: string;
                role: UserRole;
            },
            context: Context
        ) => {

            const currentUser =
                requireRole(
                    context,
                    ["ADMIN"]
                );


            if (
                currentUser.id ===
                args.userId
            ) {
                throw new AppError(
                    "You cannot change your own role.",
                    ERROR_CODES.FORBIDDEN
                );
            }


            const user =
                await prisma.user.findUnique({
                    where: {
                        id: args.userId,
                    },
                });


            if (!user) {
                throw new AppError(
                    "User not found.",
                    ERROR_CODES.USER_NOT_FOUND
                );
            }


            return prisma.user.update({
                where: {
                    id: args.userId,
                },

                data: {
                    role: args.role,
                },
            });
        },
    },
};