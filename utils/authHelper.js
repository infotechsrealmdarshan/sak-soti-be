import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import { successResponse, errorResponse } from "../utils/response.js";

dotenv.config();

/**
 * Authentication Helper
 * Handles JWT generation, verification, and expiry parsing
 */
class AuthHelper {
  constructor() {
    this.jwtSecret = process.env.JWT_SECRET;
    this.defaultExpiry = process.env.JWT_ACCESS_TOKEN_EXPIRY || "7d";
  }

  /**
   * Generate JWT Token
   */
  generateAuthToken(payload, expiry = this.defaultExpiry) {
    if (!this.jwtSecret) {
      throw new Error("JWT_SECRET is not configured in environment variables");
    }

    return jwt.sign(payload, this.jwtSecret, { expiresIn: expiry });
  }

  /**
   * Verify JWT with unified response structure
   * @returns {Promise<{statusCode, status, message, data}>}
   */
  async verifyToken(token) {
    return new Promise((resolve) => {
      jwt.verify(token, this.jwtSecret, (err, decoded) => {
        if (err) {
          if (err.name === "TokenExpiredError") {
            return resolve({
              statusCode: 401,
              message: "Token expired",
              data: null,
            });
          }

          return resolve({
            statusCode: 401,
            message: "Invalid token",
            data: null,
          });
        }

        return resolve({
          statusCode: 200,
          status: 1,
          message: "Token verified successfully",
          data: decoded,
        });
      });
    });
  }

  /**
   * Verify token ignoring expiration (for refresh use)
   */
  async ignoreExpiration(token) {
    return new Promise((resolve) => {
      jwt.verify(token, this.jwtSecret, { ignoreExpiration: true }, (err, decoded) => {
        if (err) {
          return resolve({
            statusCode: 401,
            message: "Invalid token",
            data: null,
          });
        }

        return resolve({
          statusCode: 200,
          status: 1,
          message: "Token verified (expiry ignored)",
          data: decoded,
        });
      });
    });
  }

  /**
   * Decode token safely
   */
  decodeToken(token) {
    try {
      const decoded = jwt.decode(token);
      return decoded
        ? {
            statusCode: 200,
            status: 1,
            message: "Token decoded successfully",
            data: decoded,
          }
        : {
            statusCode: 401,
            message: "Invalid token format",
            data: null,
          };
    } catch {
      return {
        statusCode: 401,
        message: "Failed to decode token",
        data: null,
      };
    }
  }

  /**
   * Parse expiry string to milliseconds
   */
  parseExpiry(expiry) {
    if (!expiry || typeof expiry !== "string") return 0;
    const match = expiry.match(/^(\d+)([hmsd])$/);
    if (!match) return 0;

    const value = parseInt(match[1], 10);
    const unit = match[2];
    const multipliers = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };
    return value * (multipliers[unit] || 0);
  }

  /**
   * Generate Access Token
   */
  generateAccessToken(user) {
    if (!this.jwtSecret) {
      throw new Error("JWT_SECRET is not configured in environment variables");
    }

    const payload = { id: user._id || user.id };
    return jwt.sign(payload, this.jwtSecret, {
      expiresIn: process.env.JWT_ACCESS_TOKEN_EXPIRY || "7d",
    });
  }

  /**
   * Generate Refresh Token
   */
  generateRefreshToken(user) {
    if (!this.jwtSecret) {
      throw new Error("JWT_SECRET is not configured in environment variables");
    }

    const payload = { id: user._id || user.id };
    return jwt.sign(payload, this.jwtSecret, {
      expiresIn: process.env.JWT_REFRESH_TOKEN_EXPIRY || "30d",
    });
  }

  /**
   * Middleware-friendly token validator
   */
  async validateAuth(req, res, next) {
    try {
      const token = req.headers.authorization?.split(" ")[1];
      if (!token) {
        return errorResponse(res, "Authorization token missing", 401);
      }

      const result = await this.verifyToken(token);
      if (result.status === 0) {
        return res.status(result.statusCode).json(result);
      }

      req.user = result.data; // attach decoded user info
      return next();
    } catch (err) {
      return errorResponse(res, "Authentication failed", 500);
    }
  }
}

export default new AuthHelper();
