import { DateTime } from "luxon";

export type TicketPriority =
    | "LOW"
    | "MEDIUM"
    | "HIGH"
    | "URGENT";

export type SLAState =
    | "ON_TRACK"
    | "AT_RISK"
    | "BREACHED";

export const BUSINESS_START_HOUR = 9;
export const BUSINESS_END_HOUR = 18;

export const BUSINESS_TIMEZONE =
    process.env.BUSINESS_TIMEZONE || "Asia/Kolkata";

export const SLA_POLICY: Record<
    TicketPriority,
    {
        firstResponseMinutes: number;
        resolutionMinutes: number;
    }
> = {
    URGENT: {
        firstResponseMinutes: 60,
        resolutionMinutes: 240,
    },
    HIGH: {
        firstResponseMinutes: 240,
        resolutionMinutes: 1440,
    },
    MEDIUM: {
        firstResponseMinutes: 480,
        resolutionMinutes: 2880,
    },
    LOW: {
        firstResponseMinutes: 1440,
        resolutionMinutes: 4320,
    },
};

export function toBusinessDateTime(
    date: Date
): DateTime {
    return DateTime.fromJSDate(date, {
        zone: BUSINESS_TIMEZONE,
    });
}

function isWeekend(date: DateTime): boolean {
    return date.weekday === 6 || date.weekday === 7;
}

function dateKey(date: DateTime): string {
    return date.toISODate()!;
}

function isHoliday(
    date: DateTime,
    holidays: Set<string>
): boolean {
    return holidays.has(dateKey(date));
}

function isBusinessDay(
    date: DateTime,
    holidays: Set<string>
): boolean {
    return !isWeekend(date) && !isHoliday(date, holidays);
}

function moveToNextBusinessDay(
    date: DateTime,
    holidays: Set<string>
): DateTime {
    let result = date.plus({ days: 1 }).startOf("day");

    while (!isBusinessDay(result, holidays)) {
        result = result.plus({ days: 1 });
    }

    return result.set({
        hour: BUSINESS_START_HOUR,
        minute: 0,
        second: 0,
        millisecond: 0,
    });
}

export function moveToBusinessTime(
    input: Date,
    holidays: Set<string>
): DateTime {
    let result = toBusinessDateTime(input);

    while (!isBusinessDay(result, holidays)) {
        result = result.plus({ days: 1 }).startOf("day");
    }

    const businessStart = result.set({
        hour: BUSINESS_START_HOUR,
        minute: 0,
        second: 0,
        millisecond: 0,
    });

    const businessEnd = result.set({
        hour: BUSINESS_END_HOUR,
        minute: 0,
        second: 0,
        millisecond: 0,
    });

    if (result < businessStart) {
        return businessStart;
    }

    if (result >= businessEnd) {
        return moveToNextBusinessDay(
            result,
            holidays
        );
    }

    return result;
}

/**
 * Adds business minutes to a timestamp.
 *
 * Business calendar:
 * Monday-Friday
 * 09:00-18:00
 * Configured holidays excluded
 */
export function addBusinessMinutes(
    input: Date,
    minutes: number,
    holidays: Set<string>
): Date {
    if (minutes <= 0) {
        return moveToBusinessTime(
            input,
            holidays
        ).toJSDate();
    }

    let current = moveToBusinessTime(
        input,
        holidays
    );

    let remaining = minutes;

    while (remaining > 0) {
        const businessEnd = current.set({
            hour: BUSINESS_END_HOUR,
            minute: 0,
            second: 0,
            millisecond: 0,
        });

        const availableMinutes = Math.max(
            0,
            businessEnd
                .diff(current, "minutes")
                .minutes
        );

        if (remaining <= availableMinutes) {
            current = current.plus({
                minutes: remaining,
            });

            remaining = 0;
            break;
        }

        remaining -= availableMinutes;

        current = moveToNextBusinessDay(
            current,
            holidays
        );
    }

    return current.toJSDate();
}

/**
 * Calculates business minutes between two timestamps.
 *
 * If end <= start, returns 0.
 */
export function calculateBusinessMinutes(
    startDate: Date,
    endDate: Date,
    holidays: Set<string>
): number {
    if (endDate <= startDate) {
        return 0;
    }

    let current = moveToBusinessTime(
        startDate,
        holidays
    );

    const end = toBusinessDateTime(endDate);

    if (current >= end) {
        return 0;
    }

    let totalMinutes = 0;

    while (current < end) {
        const businessEnd = current.set({
            hour: BUSINESS_END_HOUR,
            minute: 0,
            second: 0,
            millisecond: 0,
        });

        const segmentEnd =
            businessEnd < end
                ? businessEnd
                : end;

        if (segmentEnd > current) {
            totalMinutes += segmentEnd
                .diff(current, "minutes")
                .minutes;
        }

        if (segmentEnd >= end) {
            break;
        }

        current = moveToNextBusinessDay(
            current,
            holidays
        );
    }

    return Math.floor(totalMinutes);
}

export function calculateSlaDeadlines(
    createdAt: Date,
    priority: TicketPriority,
    holidays: Set<string>
): {
    firstResponseDueAt: Date;
    resolutionDueAt: Date;
} {
    const policy = SLA_POLICY[priority];

    return {
        firstResponseDueAt:
            addBusinessMinutes(
                createdAt,
                policy.firstResponseMinutes,
                holidays
            ),

        resolutionDueAt:
            addBusinessMinutes(
                createdAt,
                policy.resolutionMinutes,
                holidays
            ),
    };
}

export function calculateSLAState(
    createdAt: Date,
    dueAt: Date,
    completedAt: Date | null,
    now: Date,
    holidays: Set<string>
): SLAState {
    const effectiveEnd =
        completedAt ?? now;

    if (effectiveEnd >= dueAt) {
        return "BREACHED";
    }

    if (completedAt) {
        return "ON_TRACK";
    }

    const totalMinutes =
        calculateBusinessMinutes(
            createdAt,
            dueAt,
            holidays
        );

    const elapsedMinutes =
        calculateBusinessMinutes(
            createdAt,
            effectiveEnd,
            holidays
        );

    if (totalMinutes <= 0) {
        return "ON_TRACK";
    }

    const consumed =
        elapsedMinutes / totalMinutes;

    return consumed > 0.75
        ? "AT_RISK"
        : "ON_TRACK";
}

export function calculateRemainingBusinessMinutes(
    dueAt: Date,
    completedAt: Date | null,
    now: Date,
    holidays: Set<string>
): number {
    if (completedAt) {
        return 0;
    }

    if (now >= dueAt) {
        return 0;
    }

    return calculateBusinessMinutes(
        now,
        dueAt,
        holidays
    );
}