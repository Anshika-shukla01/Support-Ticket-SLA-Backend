import { describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma";

describe("Support Ticket Integration", () => {
  it("should create a ticket with the correct SLA configuration", async () => {
    // Find an existing USER
    const user = await prisma.user.findFirst({
      where: {
        role: "USER",
      },
    });

    expect(user).not.toBeNull();

    if (!user) {
      throw new Error("No USER found in database");
    }

    const before = new Date();

    const ticket = await prisma.ticket.create({
      data: {
        title: "Integration Test Ticket",
        description: "Created by Vitest integration test",
        priority: "HIGH",
        creatorId: user.id,
        slaDeadline: new Date(
          before.getTime() + 8 * 60 * 60 * 1000
        ),
      },
    });

    expect(ticket).toBeDefined();
    expect(ticket.title).toBe("Integration Test Ticket");
    expect(ticket.priority).toBe("HIGH");
    expect(ticket.status).toBe("OPEN");
    expect(ticket.slaStatus).toBe("ON_TRACK");
    expect(ticket.creatorId).toBe(user.id);

    // HIGH priority = 8-hour SLA
    const difference =
      ticket.slaDeadline.getTime() - before.getTime();

    expect(difference).toBeGreaterThanOrEqual(
      8 * 60 * 60 * 1000 - 1000
    );

    // Cleanup test data
    await prisma.ticket.delete({
      where: {
        id: ticket.id,
      },
    });
  });
});