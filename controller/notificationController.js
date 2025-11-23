import Notification from "../models/Notification.js";
import User from "../models/User.js";
import { asyncHandler } from "../utils/errorHandler.js";
import { sendFirebaseNotification } from "../utils/firebaseHelper.js";
import { successResponse, errorResponse } from "../utils/response.js";
import admin from "firebase-admin";

/**
 * @desc Create a new notification and send push if FCM token exists
 * @route POST /api/notification
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

  // Save in DB
  const notification = await Notification.create({
    userId,
    title,
    message,
    deeplink,
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
      console.log(`✅ Firebase notification sent to user ${userId}`);
    } else {
      console.error(`⚠️ Firebase send failed: ${pushResult.error}`);
      
      // Clear invalid token
      if (pushResult.error.includes('invalid-registration-token')) {
        console.log("🔄 Clearing invalid FCM token from user record");
        await User.findByIdAndUpdate(userId, { $unset: { fcmToken: 1 } });
      }
    }
  } else {
    console.warn(`⚠️ User has no FCM token, skipping push notification`);
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

  const notifications = await Notification.find({ userId })
    .sort({ createdAt: -1 });

  return successResponse(res, "Notifications fetched successfully", notifications);
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

  // Check if notification exists and belongs to the user
  const notification = await Notification.findOne({ _id: id, userId });
  if (!notification) {
    return errorResponse(res, "Notification not found", 404);
  }

  if (notification.isRead) {
    return successResponse(res, "Notification already marked as read", notification);
  }

  // Update isRead
  notification.isRead = true;
  await notification.save();

  return successResponse(res, "Notification marked as read", notification);
});