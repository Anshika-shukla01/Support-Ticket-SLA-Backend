import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { hashPassword } from "../src/auth/password";

const adapter = new PrismaPg({
    connectionString:
        process.env.DATABASE_URL!,
});

const prisma = new PrismaClient({
    adapter,
});

async function main() {
    const reporterPassword =
        await hashPassword(
            "Reporter123!"
        );

    const agentPassword =
        await hashPassword(
            "Agent123!"
        );

    const reporter =
        await prisma.user.upsert({
            where: {
                email:
                    "reporter@example.com",
            },
            update: {},
            create: {
                name: "Demo Reporter",
                email:
                    "reporter@example.com",
                passwordHash:
                    reporterPassword,
                role: "USER",
            },
        });

    const agent =
        await prisma.user.upsert({
            where: {
                email:
                    "agent@example.com",
            },
            update: {},
            create: {
                name: "Demo Agent",
                email:
                    "agent@example.com",
                passwordHash:
                    agentPassword,
                role: "AGENT",
            },
        });

    await prisma.holiday.upsert({
        where: {
            date: new Date(
                "2026-10-02T00:00:00.000Z"
            ),
        },
        update: {
            name: "Demo Holiday",
        },
        create: {
            date: new Date(
                "2026-10-02T00:00:00.000Z"
            ),
            name: "Demo Holiday",
        },
    });

    console.log(
        `Seeded reporter: ${reporter.email}`
    );

    console.log(
        `Seeded agent: ${agent.email}`
    );

    console.log(
        "Seeded demo holiday."
    );
}

main()
    .catch((error: unknown) => {
        console.error(error);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });