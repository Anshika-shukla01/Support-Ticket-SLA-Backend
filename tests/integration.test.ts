import { describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma";
import { calculateSlaDeadlines } from "../src/sla/sla";

describe("Support Ticket Integration", () => {
  it("should create a ticket with calculated SLA deadlines in PostgreSQL", async () => {
    const user = await prisma.user.findFirst({
      where: {
        role: "USER",
      },
    });

    expect(user).not.toBeNull();

    if (!user) {
      throw new Error("No USER found in database");
    }

    const holidays = new Set<string>();

    const createdAt = new Date();

    const sla = calculateSlaDeadlines(
      createdAt,
      "HIGH",
      holidays,
    );

    const ticket = await prisma.ticket.create({
      data: {
        title: "Integration Test Ticket",
        description: "Created by Vitest integration test",
        priority: "HIGH",
        creatorId: user.id,
        firstResponseDueAt: sla.firstResponseDueAt,
        resolutionDueAt: sla.resolutionDueAt,
      },
    });

    expect(ticket).toBeDefined();
    expect(ticket.title).toBe("Integration Test Ticket");
    expect(ticket.priority).toBe("HIGH");
    expect(ticket.status).toBe("OPEN");
    expect(ticket.creatorId).toBe(user.id);

    expect(ticket.firstResponseDueAt).not.toBeNull();
    expect(ticket.resolutionDueAt).not.toBeNull();

    expect(ticket.firstResponseDueAt).toEqual(
      sla.firstResponseDueAt,
    );

    expect(ticket.resolutionDueAt).toEqual(
      sla.resolutionDueAt,
    );

    expect(
      ticket.resolutionDueAt!.getTime(),
    ).toBeGreaterThan(
      ticket.firstResponseDueAt!.getTime(),
    );

    await prisma.ticket.delete({
      where: {
        id: ticket.id,
      },
    });
  });
});