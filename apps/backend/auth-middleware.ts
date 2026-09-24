import type { Request, Response, NextFunction } from "express";
import { verifyToken } from "./auth";

export interface AuthRequest extends Request {
    userId?: string;
}

export async function authMiddleware(
    req: AuthRequest,
    res: Response,
    next: NextFunction,
) {
    try {
        const authorization = req.headers.authorization;

        if (!authorization) {
            return res.status(401).json({
                error: "Authorization header required",
            });
        }

        const [scheme, token] = authorization.split(" ");

        if (scheme !== "Bearer" || !token) {
            return res.status(401).json({
                error: "Invalid authorization format",
            });
        }

        const userId = await verifyToken(token);

        req.userId = userId;

        next();
    } catch (error) {
        return res.status(401).json({
            error: "Invalid or expired token",
        });
    }
}