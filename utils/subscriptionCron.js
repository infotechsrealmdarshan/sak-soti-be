import User from "../models/User.js";
import redisClient from "../config/redis.js";

/**
 * Check and update expired subscriptions
 * This function checks all users and expires subscriptions that have passed their end date
 * Should be called every 5 minutes via cron job
 */
export const checkExpiredSubscriptions = async () => {
  try {
    console.log("🔄 Checking expired subscriptions...");

    const now = new Date();

    // Find all users with active subscription but expired end date
    const expiredUsers = await User.find({
      isSubscription: true,
      subscriptionEndDate: { $lt: now }, // End date is less than current date
    });

    if (expiredUsers.length === 0) {
      console.log("✅ No expired subscriptions found");
      return { expired: 0, updated: 0 };
    }

    console.log(`⚠️ Found ${expiredUsers.length} expired subscriptions`);

    // Update expired users
    let updatedCount = 0;
    for (const user of expiredUsers) {
      // Set lastSubscriptionDate to the expired end date
      if (user.subscriptionEndDate) {
        user.lastSubscriptionDate = user.subscriptionEndDate;
      }

      // Clear subscription fields
      user.isSubscription = false;
      user.subscriptionType = null;
      user.subscriptionStartDate = null;
      user.subscriptionEndDate = null;

      await user.save();

      // Clear user cache from Redis
      try {
        await redisClient.del(`user:${user._id}`);
      } catch (redisError) {
        console.warn(`⚠️ Redis cache clear failed for user ${user._id}:`, redisError.message);
      }

      updatedCount++;
      console.log(`✅ Subscription expired for user: ${user.email}`);
    }

    console.log(`✅ Updated ${updatedCount} expired subscriptions`);

    return {
      expired: expiredUsers.length,
      updated: updatedCount,
    };
  } catch (error) {
    console.error("❌ Error checking expired subscriptions:", error.message);
    return {
      expired: 0,
      updated: 0,
      error: error.message,
    };
  }
};

