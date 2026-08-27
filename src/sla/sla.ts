const SLA_HOURS = {
    LOW: 48,
    MEDIUM: 24,
    HIGH: 8,
    URGENT: 4,
} as const;

const BUSINESS_START_HOUR = 9;
const BUSINESS_END_HOUR = 17;

type TicketPriority = keyof typeof SLA_HOURS;

function isWeekend(date: Date): boolean {
    const day = date.getDay();

    return day === 0 || day === 6;
}

function moveToBusinessTime(date: Date): Date {
    const result = new Date(date);

    // Move weekend → Monday
    while (isWeekend(result)) {
        result.setDate(result.getDate() + 1);
        result.setHours(BUSINESS_START_HOUR, 0, 0, 0);
    }

    // Before business hours
    if (result.getHours() < BUSINESS_START_HOUR) {
        result.setHours(BUSINESS_START_HOUR, 0, 0, 0);
    }

    // After business hours
    if (result.getHours() >= BUSINESS_END_HOUR) {
        result.setDate(result.getDate() + 1);

        while (isWeekend(result)) {
            result.setDate(result.getDate() + 1);
        }

        result.setHours(BUSINESS_START_HOUR, 0, 0, 0);
    }

    return result;
}

export function calculateSlaDeadline(
    createdAt: Date,
    priority: TicketPriority
): Date {
    let current = moveToBusinessTime(createdAt);
    let remainingHours = SLA_HOURS[priority];

    while (remainingHours > 0) {
        current = moveToBusinessTime(current);

        const businessEnd = new Date(current);

        businessEnd.setHours(
            BUSINESS_END_HOUR,
            0,
            0,
            0
        );

        const availableMilliseconds =
            businessEnd.getTime() - current.getTime();

        const availableHours =
            availableMilliseconds / (1000 * 60 * 60);

        if (remainingHours <= availableHours) {
            current = new Date(
                current.getTime() +
                remainingHours * 60 * 60 * 1000
            );

            remainingHours = 0;
        } else {
            remainingHours -= availableHours;

            current.setDate(current.getDate() + 1);

            while (isWeekend(current)) {
                current.setDate(current.getDate() + 1);
            }

            current.setHours(
                BUSINESS_START_HOUR,
                0,
                0,
                0
            );
        }
    }

    return current;
}