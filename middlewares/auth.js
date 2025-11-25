import jwt from "jsonwebtoken";
import User from "../models/User.js";
import redisClient from "../config/redis.js";
import { errorResponse, successResponse } from "../utils/response.js";
import authHelper from "../utils/authHelper.js";

const auth = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return errorResponse(res, "No token provided", 404);
  }

  const token = authHeader.split(" ")[1];
  const refreshToken = req.headers["x-refresh-token"]; // Client can send refresh token in header

  try {
    // ✅ Verify access token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const user = await User.findById(decoded.id);
    if (!user) return successResponse(res, "User not found", null, null, 200, 0);

    // ✅ Check if user account is deleted
    if (user.isDeleted === true) {
      return successResponse(
        res,
        "This account has been deleted. Please contact support team to restore your account.",
        null,
        null,
        200,
        0
      );
    }

    req.user = { id: user._id, email: user.email, isAdmin: user.isAdmin, isSubscription: user.isSubscription };
    next();
  } catch (err) {
    // ✅ Handle expired access token
    if (err.name === "TokenExpiredError") {
      // If refresh token is not provided, send clear expiry message
      if (!refreshToken) {
        return errorResponse(res, "Access token expired", 401);
      }

      // Try refreshing
      try {
        const refreshDecoded = jwt.verify(refreshToken, process.env.JWT_SECRET);

        // Validate refresh token in Redis
        const storedToken = await redisClient.get(`refreshToken:${refreshDecoded.id}`);
        if (!storedToken || storedToken !== refreshToken) {
          return errorResponse(res, "Invalid or expired refresh token", 401);
        }

        const user = await User.findById(refreshDecoded.id);
        if (!user) {
          return errorResponse(res, "User not found", 404);
        }

        // ✅ Check if user account is deleted
        if (user.isDeleted === true) {
          return successResponse(
            res,
            "This account has been deleted. Please contact support team to restore your account.",
            null,
            null,
            200,
            0
          );
        }

        // Generate new access token
        const newAccessToken = authHelper.generateAccessToken({ _id: refreshDecoded.id });
        res.setHeader("x-new-access-token", newAccessToken);

        req.user = { id: user._id, email: user.email, isAdmin: user.isAdmin, isSubscription: user.isSubscription };
        next();
      } catch (refreshErr) {
        if (refreshErr.name === "TokenExpiredError") {
          return errorResponse(res, "Refresh token expired", 401);
        }
        return errorResponse(res, "Invalid refresh token", 401);
      }
    }

    // ✅ Handle other invalid token errors (wrong signature, malformed, etc.)
    else if (err.name === "JsonWebTokenError") {
      return errorResponse(res, "Invalid access token", 401);
    }

    // ✅ Catch all (just in case)
    else {
      return errorResponse(res, "Token verification failed", 401);
    }
  }
};

export default auth;
