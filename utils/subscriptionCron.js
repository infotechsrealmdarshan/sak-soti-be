import User from "../models/User.js";
import redisClient from "../config/redis.js";
import Subscription from "../models/Subscription.js"; // Add this import
import logger from "./logger.js";

/**
 * Check and update expired subscriptions
 * This function checks all users and expires subscriptions that have passed their end date
 * Should be called every 5 minutes via cron job
 */
export const checkExpiredSubscriptions = async () => {
  try {
    logger.log("🔄 Checking expired subscriptions...");

    const now = new Date();

    // Find all users with active subscription but expired end date
    const expiredUsers = await User.find({
      isSubscription: true,
      subscriptionEndDate: { $lt: now }, // End date is less than current date
    });

    if (expiredUsers.length === 0) {
      logger.log("✅ No expired subscriptions found");
      return { expired: 0, updated: 0 };
    }

    logger.log(`⚠️ Found ${expiredUsers.length} expired subscriptions`);

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
        logger.warn(`⚠️ Redis cache clear failed for user ${user._id}:`, redisError.message);
      }

      updatedCount++;
      logger.log(`✅ Subscription expired for user: ${user.email}`);
    }

    logger.log(`✅ Updated ${updatedCount} expired subscriptions`);

    return {
      expired: expiredUsers.length,
      updated: updatedCount,
    };
  } catch (error) {
    logger.error("❌ Error checking expired subscriptions:", error.message);
    return {
      expired: 0,
      updated: 0,
      error: error.message,
    };
  }
};

export const checkAndExpireSubscription = async (user) => {
  if (!user.isSubscription || !user.subscriptionEndDate) {
    return { expired: false, user };
  }

  // ✅ FIRST: Check if user has ACTIVE Stripe subscription
  const activeSubscription = await Subscription.findOne({
    userId: user._id,
    status: 'active'
  });

  // ✅ If Stripe subscription is ACTIVE, DON'T expire (even if local date passed)
  if (activeSubscription) {
    logger.log(`✅ User ${user.email} has active Stripe subscription - skipping manual expiration`);
    return { expired: false, user };
  }

  const now = new Date();

  // ✅ Only expire if subscription end date passed AND no active Stripe subscription
  if (user.subscriptionEndDate < now) {
    logger.log(`🔄 Auto-expiring subscription for user: ${user.email}`);

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

    // Update subscription record
    try {
      await Subscription.findOneAndUpdate(
        { userId: user._id, status: { $in: ['active', 'trialing'] } },
        {
          status: 'expired',
          endDate: now
        }
      );
      logger.log(`✅ Subscription record updated to expired for user: ${user.email}`);
    } catch (subError) {
      logger.warn(`⚠️ Could not update subscription record: ${subError.message}`);
    }

    return { expired: true, user };
  }

  return { expired: false, user };
};