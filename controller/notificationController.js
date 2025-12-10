import Notification from "../models/Notification.js";
import User from "../models/User.js";
import { asyncHandler } from "../utils/errorHandler.js";
import { sendFirebaseNotification } from "../utils/firebaseHelper.js";
import logger from "../utils/logger.js";
import { successResponse, errorResponse } from "../utils/response.js";
import admin from "firebase-admin";

/**
 * @desc Create a new notification and send push if FCM token exists
 * @route POST /api/notification`
 * @access Private
 */
export const createNotification = asyncHandler(async (req, res) => {
  const { userId, title, message, deeplink = "" } = req.body;

  if (!userId || !title || !message) {
    return errorResponse(res, "userId, title, and message are required", 400);
  }

  // Fetch the user to get FCM token and name
  const user = await User.findById(userId);
  if (!user) return errorResponse(res, "User not found", 404);

  // Save in DB with isExpired default false
  const notification = await Notification.create({
    userId,
    title,
    message,
    deeplink,
    isExpired: false // Explicitly set to false
  });

  // ✅ Use your sendFirebaseNotification helper consistently
  if (user.fcmToken) {
    const pushResult = await sendFirebaseNotification(
      user.fcmToken,
      title,
      message,
      { deeplink, type: "general" }
    );

    // Update notification status based on FCM result
    notification.firebaseStatus = pushResult.success ? "sent" : "failed";
    await notification.save();

    if (pushResult.success) {
      logger.log(`✅ Firebase notification sent to user ${userId}`);
    } else {
      logger.error(`⚠️ Firebase send failed: ${pushResult.error}`);

      // Clear invalid token
      if (pushResult.error.includes('invalid-registration-token')) {
        logger.log("🔄 Clearing invalid FCM token from user record");
        await User.findByIdAndUpdate(userId, { $unset: { fcmToken: 1 } });
      }
    }
  } else {
    logger.warn(`⚠️ User has no FCM token, skipping push notification`);
    notification.firebaseStatus = "no_token";
    await notification.save();
  }

  return successResponse(res, "Notification created & sent successfully", notification);
});

/**
 * @desc Get all notifications for a logged-in user (via auth token)
 * @route GET /api/notification
 * @access Private/User
 */
export const getUserNotifications = asyncHandler(async (req, res) => {
  // userId is extracted from token by auth middleware
  const userId = req.user?.id;

  if (!userId) {
    return errorResponse(res, "Unauthorized: Invalid or missing token", 401);
  }

  // Auto-expire notifications older than 7 days
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  // Update isExpired for notifications older than 7 days
  await Notification.updateMany(
    {
      userId,
      createdAt: { $lt: sevenDaysAgo },
      isExpired: false // Only update those that are not already expired
    },
    {
      $set: { isExpired: true }
    }
  );

  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const skip = (page - 1) * limit;

  const includeExpired = req.query.includeExpired === 'true';

  const query = { userId };

  if (!includeExpired) {
    query.isExpired = false;
  }

  const notifications = await Notification.find(query)
    .sort({
      isRead: 1,
      createdAt: -1
    })
    .skip(skip)
    .limit(limit);

  const totalNotifications = await Notification.countDocuments(query);
  const totalPages = Math.ceil(totalNotifications / limit);

  return successResponse(res, "Notifications fetched successfully", {
    notifications,
    pagination: {
      currentPage: page,
      totalPages,
      totalNotifications,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
      limit
    },
  });
});

/**
 * @desc Mark a notification as read
 * @route PATCH /api/notification/:id/read
 * @access Private/User
 */
export const markNotificationAsRead = asyncHandler(async (req, res) => {
  const userId = req.user?.id;
  const { id } = req.params;

  if (!userId) {
    return errorResponse(res, "Unauthorized: Invalid token", 401);
  }

  // Check if notification exists, belongs to the user, and is not expired
  const notification = await Notification.findOne({
    _id: id,
    userId,
    isExpired: false // Only allow marking as read for non-expired notifications
  });

  if (!notification) {
    return errorResponse(res, "Notification not found or expired", 404);
  }

  if (notification.isRead) {
    return successResponse(res, "Notification already marked as read", notification);
  }

  // Update isRead
  notification.isRead = true;
  await notification.save();

  return successResponse(res, "Notification marked as read", notification);
});

/**
 * @desc Cleanup expired notifications (optional manual cleanup endpoint)
 * @route DELETE /api/notification/cleanup
 * @access Private/User
 */
export const cleanupExpiredNotifications = asyncHandler(async (req, res) => {
  const userId = req.user?.id;

  if (!userId) {
    return errorResponse(res, "Unauthorized: Invalid token", 401);
  }

  // Delete notifications that are expired
  const result = await Notification.deleteMany({
    userId,
    isExpired: true
  });

  return successResponse(res, "Expired notifications cleaned up successfully", {
    deletedCount: result.deletedCount
  });
});

/**
 * @desc Get all notifications including expired (for admin purposes)
 * @route GET /api/notification/all
 * @access Private/User
 */
export const getAllNotificationsIncludingExpired = asyncHandler(async (req, res) => {
  const userId = req.user?.id;

  if (!userId) {
    return errorResponse(res, "Unauthorized: Invalid token", 401);
  }

  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const skip = (page - 1) * limit;

  // Get all notifications including expired
  const notifications = await Notification.find({ userId })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit);

  const totalNotifications = await Notification.countDocuments({ userId });
  const totalPages = Math.ceil(totalNotifications / limit);

  return successResponse(res, "All notifications fetched successfully", {
    notifications,
    pagination: {
      currentPage: page,
      totalPages,
      totalNotifications,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
      limit
    }
  });
});