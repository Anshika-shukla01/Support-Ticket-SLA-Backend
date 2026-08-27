import { prisma } from "../lib/prisma";
import { hashPassword } from "./password";

export async function bootstrapAdmin() {
    const adminEmail = process.env.ADMIN_EMAIL;
    const adminPassword = process.env.ADMIN_PASSWORD;
    const adminName = process.env.ADMIN_NAME || "System Admin";

    if (!adminEmail || !adminPassword) {
        console.warn(
            "ADMIN_EMAIL or ADMIN_PASSWORD is not configured. Skipping admin bootstrap."
        );
        return;
    }

    const existingAdmin = await prisma.user.findFirst({
        where: {
            role: "ADMIN",
        },
    });

    if (existingAdmin) {
        console.log(
            `Admin already exists: ${existingAdmin.email}`
        );
        return;
    }

    const existingUser = await prisma.user.findUnique({
        where: {
            email: adminEmail,
        },
    });

    if (existingUser) {
        await prisma.user.update({
            where: {
                id: existingUser.id,
            },
            data: {
                role: "ADMIN",
            },
        });

        console.log(
            `Existing user promoted to ADMIN: ${adminEmail}`
        );

        return;
    }

    const passwordHash = await hashPassword(
        adminPassword
    );

    const admin = await prisma.user.create({
        data: {
            name: adminName,
            email: adminEmail,
            passwordHash,
            role: "ADMIN",
        },
    });

    console.log(
        `Initial ADMIN account created: ${admin.email}`
    );
}