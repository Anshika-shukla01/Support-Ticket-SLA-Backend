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
import { DateTime } from "luxon";

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

const ticketInclude = {
    creator: true,
    agent: true,
    comments: {
        include: {
            author: true,
        },
    },
};

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

    if (
        !ALLOWED_STATUS_TRANSITIONS[
            current
        ].includes(next)
    ) {
        throw new Error(
            `Invalid status transition: ${current} → ${next}`
        );
    }
}

async function getHolidayKeys(): Promise<Set<string>> {
    const holidays = await prisma.holiday.findMany({
        select: {
            date: true,
        },
    });

    return new Set(
        holidays.map((holiday) =>
            DateTime.fromJSDate(holiday.date, {
                zone: BUSINESS_TIMEZONE,
            }).toISODate()!
        )
    );
}

export const resolvers = {
    // --------------------------------
    // TICKETS RESOLVER
    // --------------------------------
    Ticket: {
        firstResponseDueAt: (
            ticket: {
                firstResponseDueAt: Date;
            }
        ) => ticket.firstResponseDueAt.toISOString(),

        resolutionDueAt: (
            ticket: {
                resolutionDueAt: Date;
            }
        ) => ticket.resolutionDueAt.toISOString(),

        sla: async (
            ticket: {
                createdAt: Date;
                firstResponseDueAt: Date;
                resolutionDueAt: Date;
                firstResponseAt: Date | null;
                resolvedAt: Date | null;
            }
        ) => {
            const holidays =
                await getHolidayKeys();

            const now = new Date();

            return {
                firstResponseDueAt:
                    ticket.firstResponseDueAt.toISOString(),

                resolutionDueAt:
                    ticket.resolutionDueAt.toISOString(),

                firstResponseState:
                    calculateSLAState(
                        ticket.createdAt,
                        ticket.firstResponseDueAt,
                        ticket.firstResponseAt,
                        now,
                        holidays
                    ),

                resolutionState:
                    calculateSLAState(
                        ticket.createdAt,
                        ticket.resolutionDueAt,
                        ticket.resolvedAt,
                        now,
                        holidays
                    ),

                firstResponseRemainingMinutes:
                    calculateRemainingBusinessMinutes(
                        ticket.firstResponseDueAt,
                        ticket.firstResponseAt,
                        now,
                        holidays
                    ),

                resolutionRemainingMinutes:
                    calculateRemainingBusinessMinutes(
                        ticket.resolutionDueAt,
                        ticket.resolvedAt,
                        now,
                        holidays
                    ),
            };
        },
    },
    Query: {
        // --------------------------------
        // GET ALL TICKETS
        // --------------------------------
        tickets: async (
            _: unknown,
            args: {
                filter?: {
                    status?: TicketStatus;
                    priority?: TicketPriority;
                    slaStatus?: "ON_TRACK" | "AT_RISK" | "BREACHED";
                };
                page?: number;
                pageSize?: number;
            },
            context: Context
        ) => {
            requireAuth(context);

            const page = args.page ?? 1;
            const pageSize = args.pageSize ?? 10;

            if (page < 1) {
                throw new Error("Page must be greater than 0");
            }

            if (pageSize < 1 || pageSize > 100) {
                throw new Error(
                    "Page size must be between 1 and 100"
                );
            }

            const user = requireAuth(context);

            const where = {
                ...(user.role === "USER" && { creatorId: user.id }),
                ...(user.role === "AGENT" && { agentId: user.id }),
                ...(args.filter?.status && { status: args.filter.status }),
                ...(args.filter?.priority && { priority: args.filter.priority }),
                ...(args.filter?.slaStatus && { slaStatus: args.filter.slaStatus }),
            };

            const skip = (page - 1) * pageSize;

            const [items, total] =
                await Promise.all([
                    prisma.ticket.findMany({
                        where,
                        include: ticketInclude,
                        orderBy: {
                            createdAt: "desc",
                        },
                        skip,
                        take: pageSize,
                    }),

                    prisma.ticket.count({
                        where,
                    }),
                ]);

            return {
                items,
                total,
                page,
                pageSize,
                totalPages: Math.ceil(
                    total / pageSize
                ),
            };
        },

        // --------------------------------
        // GET SINGLE TICKET
        // --------------------------------
        ticket: async (
            _: unknown,
            args: { id: string },
            context: Context
        ) => {
            const user = requireAuth(context);

            const ticket =
                await prisma.ticket.findUnique({
                    where: {
                        id: args.id,
                    },
                    include: ticketInclude,
                });

            if (!ticket) {
                return null;
            }

            // USER can only see their own tickets
            if (
                user.role === "USER" &&
                ticket.creatorId !== user.id
            ) {
                throw new Error(
                    "You are not allowed to view this ticket"
                );
            }

            // AGENT can see tickets assigned to them
            // ADMIN can see everything
            if (
                user.role === "AGENT" &&
                ticket.agentId !== user.id
            ) {
                throw new Error(
                    "You are not allowed to view this ticket"
                );
            }

            return ticket;
        },

        // --------------------------------
        // GET HOLIDAY QUERY
        // --------------------------------

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

        // --------------------------------
        // AGENTS
        // --------------------------------
        agents: async (
            _: unknown,
            __: unknown,
            context: Context
        ) => {
            const user = requireRole(
                context,
                ["AGENT", "ADMIN"]
            );

            return prisma.user.findMany({
                where: { role: "AGENT" },
                orderBy: { name: "asc" },
            });
        },


        // --------------------------------
        // CREATE USER
        // --------------------------------

        users: async (
            _: unknown,
            __: unknown,
            context: Context
        ) => {
            const user = requireRole(
                context,
                ["AGENT", "ADMIN"]
            );

            return prisma.user.findMany({
                orderBy: {
                    createdAt: "desc",
                },
            });
        },

        // --------------------------------
        // CURRENT USER
        // --------------------------------
        me: async (
            _: unknown,
            __: unknown,
            context: Context
        ) => {
            return context.user;
        },
    },

    Mutation: {
        // --------------------------------
        // REGISTER
        // --------------------------------
        register: async (
            _: unknown,
            args: {
                name: string;
                email: string;
                password: string;
                role: "USER" | "AGENT" | "ADMIN";
            }
        ) => {
            const existingUser =
                await prisma.user.findUnique({
                    where: {
                        email: args.email,
                    },
                });

            if (existingUser) {
                throw new Error(
                    "Email already registered"
                );
            }

            if (args.password.length < 6) {
                throw new Error(
                    "Password must be at least 6 characters"
                );
            }

            const passwordHash =
                await hashPassword(args.password);

            if (args.role === "ADMIN") {
                throw new Error(
                    "ADMIN accounts cannot be created through public registration."
                );
            }

            const user = await prisma.user.create({
                data: {
                    name: args.name,
                    email: args.email,
                    passwordHash,
                    role: args.role,
                },
            });

            const token = await createToken(user.id);

            return {
                token,
                user,
            };
        },

        // --------------------------------
        // LOGIN
        // --------------------------------
        login: async (
            _: unknown,
            args: {
                email: string;
                password: string;
            }
        ) => {
            const user =
                await prisma.user.findUnique({
                    where: {
                        email: args.email,
                    },
                });

            if (!user) {
                throw new Error(
                    "Invalid email or password"
                );
            }

            const validPassword =
                await verifyPassword(
                    args.password,
                    user.passwordHash
                );

            if (!validPassword) {
                throw new Error(
                    "Invalid email or password"
                );
            }

            const token = await createToken(user.id);

            return {
                token,
                user,
            };
        },

        // --------------------------------
        // CREATE TICKET
        // --------------------------------
        createTicket: async (
            _: unknown,
            args: {
                title: string;
                description: string;
                priority: TicketPriority;
            },
            context: Context
        ) => {
            const user = requireAuth(context);

            if (args.title.trim().length === 0) {
                throw new Error("Title cannot be empty");
            }

            if (args.description.trim().length === 0) {
                throw new Error("Description cannot be empty");
            }

            const createdAt = new Date();

            const holidays =
                await getHolidayKeys();

            const {
                firstResponseDueAt,
                resolutionDueAt,
            } = calculateSlaDeadlines(
                createdAt,
                args.priority,
                holidays
            );

            return prisma.ticket.create({
                data: {
                    title: args.title.trim(),
                    description: args.description.trim(),
                    priority: args.priority,
                    creatorId: user.id,
                    firstResponseDueAt,
                    resolutionDueAt,
                    createdAt,
                },
                include: ticketInclude,
            });
        },

        // --------------------------------
        // ASSIGN TICKET
        // --------------------------------
        assignTicket: async (
            _: unknown,
            args: {
                ticketId: string;
                agentId: string;
            },
            context: Context
        ) => {
            const user = requireRole(
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
                throw new Error(
                    "Agent not found"
                );
            }

            if (agent.role !== "AGENT") {
                throw new Error(
                    "Selected user is not an agent"
                );
            }

            const ticket =
                await prisma.ticket.findUnique({
                    where: {
                        id: args.ticketId,
                    },
                });

            if (!ticket) {
                throw new Error(
                    "Ticket not found"
                );
            }

            return prisma.ticket.update({
                where: {
                    id: args.ticketId,
                },
                data: {
                    agentId: args.agentId,
                    status: "IN_PROGRESS",
                },
                include: ticketInclude,
            });
        },

        // --------------------------------
        // RESOLVE TICKET
        // --------------------------------

        resolveTicket: async (
            _: unknown,
            args: {
                ticketId: string;
            },
            context: Context
        ) => {
            const user = requireAuth(context);

            const ticket =
                await prisma.ticket.findUnique({
                    where: {
                        id: args.ticketId,
                    },
                });

            if (!ticket) {
                throw new Error(
                    "Ticket not found"
                );
            }

            if (user.role === "USER") {
                throw new Error(
                    "Users cannot resolve tickets"
                );
            }

            if (
                user.role === "AGENT" &&
                ticket.agentId !== user.id
            ) {
                throw new Error(
                    "You are not allowed to resolve this ticket"
                );
            }

            validateStatusTransition(
                ticket.status,
                "RESOLVED"
            );

            const resolvedAt = new Date();

            return prisma.ticket.update({
                where: {
                    id: ticket.id,
                },
                data: {
                    status: "RESOLVED",
                    resolvedAt,
                },
                include: ticketInclude,
            });
        },


        // --------------------------------
        // UPDATE USERROLE
        // --------------------------------
        updateUserRole: async (
            _: unknown,
            args: {
                userId: string;
                role: "USER" | "AGENT" | "ADMIN";
            },
            context: Context
        ) => {
            const currentUser = requireRole(context, ["ADMIN"]);

            if (currentUser.id === args.userId) {
                throw new Error(
                    "You cannot change your own role"
                );
            }

            const user = await prisma.user.findUnique({
                where: {
                    id: args.userId,
                },
            });

            if (!user) {
                throw new Error("User not found");
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

        // --------------------------------
        // UPDATE TICKET STATUS
        // --------------------------------
        updateTicketStatus: async (
            _: unknown,
            args: {
                ticketId: string;
                status: TicketStatus;
            },
            context: Context
        ) => {
            const user = requireAuth(context);

            const ticket =
                await prisma.ticket.findUnique({
                    where: {
                        id: args.ticketId,
                    },
                });

            if (!ticket) {
                throw new Error(
                    "Ticket not found"
                );
            }

            validateStatusTransition(
                ticket.status,
                args.status
            );

            // USER cannot manage ticket status
            if (user.role === "USER") {
                throw new Error(
                    "Users cannot update ticket status"
                );
            }

            // AGENT can only update tickets assigned to them
            if (
                user.role === "AGENT" &&
                ticket.agentId !== user.id
            ) {
                throw new Error(
                    "You are not allowed to update this ticket"
                );
            }

            const data: {
                status: TicketStatus;
                firstResponseAt?: Date;
                resolvedAt?: Date;
            } = {
                status: args.status,
            };

            // Resolution
            if (
                args.status === "RESOLVED" &&
                !ticket.resolvedAt
            ) {
                data.resolvedAt =
                    new Date();
            }

            return prisma.ticket.update({
                where: {
                    id: args.ticketId,
                },
                data,
                include: ticketInclude,
            });
        },

        // --------------------------------
        // CREATE COMMENT
        // --------------------------------
        createComment: async (
            _: unknown,
            args: {
                ticketId: string;
                content: string;
            },
            context: Context
        ) => {
            const user = requireAuth(context);

            const ticket =
                await prisma.ticket.findUnique({
                    where: {
                        id: args.ticketId,
                    },
                });

            if (!ticket) {
                throw new Error(
                    "Ticket not found"
                );
            }

            if (
                user.role === "USER" &&
                ticket.creatorId !== user.id
            ) {
                throw new Error(
                    "You are not allowed to comment on this ticket"
                );
            }

            if (
                user.role === "AGENT" &&
                ticket.agentId !== user.id
            ) {
                throw new Error(
                    "You are not allowed to comment on this ticket"
                );
            }

            if (args.content.trim().length === 0) {
                throw new Error(
                    "Comment cannot be empty"
                );
            }

            const comment =
                await prisma.comment.create({
                    data: {
                        content: args.content.trim(),
                        ticketId: args.ticketId,
                        authorId: user.id,
                    },
                    include: {
                        author: true,
                    },
                });

            // Track first response
            if (
                user.id !== ticket.creatorId &&
                !ticket.firstResponseAt
            ) {
                await prisma.ticket.update({
                    where: {
                        id: ticket.id,
                    },
                    data: {
                        firstResponseAt:
                            comment.createdAt,
                    },
                });
            }

            return comment;
        },
    },
};