import { prisma } from "../lib/prisma";
import { verifyToken } from "./jwt";

export type Context = {
  user: {
    id: string;
    name: string;
    email: string;
    role: "USER" | "AGENT" | "ADMIN";
  } | null;
};

export async function createContext({
  request,
}: {
  request: Request;
}): Promise<Context> {
  const authorization = request.headers.get("authorization");

  if (!authorization) {
    return {
      user: null,
    };
  }

  const [scheme, token] = authorization.split(" ");

  if (scheme !== "Bearer" || !token) {
    return {
      user: null,
    };
  }

  try {
    const payload = await verifyToken(token);

    const user = await prisma.user.findUnique({
      where: {
        id: payload.userId,
      },
    });

    return {
      user,
    };
  } catch {
    return {
      user: null,
    };
  }
}