import mongoose from "mongoose";
import Notification from "../models/Notification.js";
import User from "../models/User.js";
import { sendFirebaseNotification } from "./firebaseHelper.js";

const resolveUser = async (userOrId) => {
  if (!userOrId) return null;
  if (typeof userOrId === "string" || userOrId instanceof mongoose.Types.ObjectId) {
    return User.findById(userOrId).select("firstname lastname email fcmToken");
  }
  if (userOrId._id) {
    return userOrId;
  }
  return null;
};

const safeString = (value, fallback = "") => {
  if (value === null || value === undefined) return fallback;
  return String(value);
};

export const notifyUser = async (userOrId, title, message, options = {}) => {
  const { deeplink = "", data = {} } = options;
  try {
    const user = await resolveUser(userOrId);
    if (!user?._id) return null;

    const notification = await Notification.create({
      userId: user._id,
      title: safeString(title),
      message: safeString(message),
      deeplink: safeString(deeplink),
    });

    if (user.fcmToken) {
      const payloadData = Object.entries({
        type: "subscription_event",
        ...data,
      }).reduce(
        (acc, [key, value]) => ({
          ...acc,
          [key]: safeString(value),
        }),
        {}
      );

      const pushResult = await sendFirebaseNotification(
        user.fcmToken,
        safeString(title),
        safeString(message),
        payloadData
      );

      notification.firebaseStatus = pushResult.success ? "sent" : "failed";
      await notification.save();

      if (
        !pushResult.success &&
        pushResult.error &&
        pushResult.error.includes("invalid-registration-token")
      ) {
        await User.findByIdAndUpdate(user._id, { $unset: { fcmToken: 1 } });
      }
    }
    console.log(`✅ Notification created for user ${user._id}: ${notification}`);
    return notification;
  } catch (error) {
    console.error("notifyUser error:", error);
    return null;
  }
};

export const notifyUsers = async (usersOrIds, title, message, options = {}) => {
  if (!Array.isArray(usersOrIds) || usersOrIds.length === 0) return [];
  const results = [];
  for (const user of usersOrIds) {
    try {
      const result = await notifyUser(user, title, message, options);
      results.push(result);
    } catch (error) {
      console.error("notifyUsers iteration error:", error);
    }
  }
  return results;
};


