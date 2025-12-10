import admin from "firebase-admin";
import { initializeFirebase } from "../config/firebase.js";
import logger from "./logger.js";

initializeFirebase(); // Ensure Firebase is initialized once

/**
 * Validate FCM token format
 */
export const isValidFCMToken = (token) => {
  if (!token || typeof token !== 'string') return false;

  const trimmed = token.trim();// Basic length check (FCM tokens are typically 150+ characters)
  if (trimmed.length < 100 || trimmed.length > 500) return false;

  // Format check: should have colon and valid characters
  if (!trimmed.includes(':')) return false;

  const parts = trimmed.split(':');
  if (parts.length !== 2) return false;

  // Character validation
  const validChars = /^[a-zA-Z0-9:_-]+$/;
  return validChars.test(trimmed);
};

/**
 * Send a push notification using Firebase Cloud Messaging
 */
export const sendFirebaseNotification = async (fcmToken, title, body, data = {}) => {
  logger.log("🔍 FCM Debug - Starting notification send");
  logger.log("FCM Token received:", fcmToken);
  logger.log("Token type:", typeof fcmToken);
  logger.log("Token length:", fcmToken?.length);

  if (!fcmToken) {
    logger.warn("⚠️ Missing FCM token — notification skipped");
    return { success: false, message: "Missing FCM token" };
  }

  // Enhanced token validation
  if (!isValidFCMToken(fcmToken)) {
    logger.warn("⚠️ Skipping invalid FCM token:", fcmToken);
    return { success: false, skipped: true };
  }

  const trimmedToken = fcmToken.trim();
  logger.log("✅ Token format valid, proceeding with send...");

  try {
    const payload = {
      notification: {
        title: String(title || ''),
        body: String(body || '')
      },
      data: Object.entries(data).reduce(
        (acc, [key, value]) => ({
          ...acc,
          [key]: String(value ?? ""),
        }),
        {}
      ),
      token: trimmedToken,
    };

    logger.log("📤 Attempting to send FCM payload...");
    const response = await admin.messaging().send(payload);
    logger.log("✅ Firebase push sent successfully");

    return { success: true, response };
  } catch (error) {
    logger.error("❌ FCM Error Details:");
    logger.error("Error message:", error.message);
    logger.error("Error code:", error.code);
    logger.error("Error details:", error.details);

    // Handle specific FCM errors
    if (error.code === 'messaging/invalid-registration-token') {
      logger.error("🔄 Token is invalid - needs to be refreshed");
    } else if (error.code === 'messaging/registration-token-not-registered') {
      logger.error("🔄 Token not registered - app may be uninstalled");
    }

    return { success: false, error: error.message };
  }
};