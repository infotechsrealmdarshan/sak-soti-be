import User from "../models/User.js";
import Subscription from "../models/Subscription.js";
import News from "../models/News.js";
import Post from "../models/Post.js";
import { asyncHandler } from "../utils/errorHandler.js";
import { successResponse } from "../utils/response.js";

export const getAdminAnalytics = asyncHandler(async (req, res) => {
  const now = new Date();

  // Time ranges for graphs
  const startOfYear = new Date(now.getFullYear(), 0, 1);

  // Time ranges for counts
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);

  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - 7);
  startOfWeek.setHours(0, 0, 0, 0);

  // Execute all queries in parallel
  const [
    totalUsers,
    totalDeletedUsers,
    totalActiveUsers,
    totalInactiveUsers,
    todayUsers,
    weekUsers,
    totalSubscribedUsers,
    totalSubscriptionActiveUsers,
    totalSubscriptionInactiveUsers,
    totalPosts,
    totalNews,
    monthlyTotalData,
    monthlyActiveData,
    monthlyInactiveData
  ] = await Promise.all([
    // 1. Total users (all users regardless of status and deletion)
    User.countDocuments(),

    // 2. Total Deleted users (isDeleted: true) - ONLY DELETED USERS
    User.countDocuments({ isDeleted: true }),

    // 3. Total Active users (isDeleted: false AND status: "active")
    User.countDocuments({ isDeleted: false, status: "active" }),

    // 4. Total Inactive users (isDeleted: false AND status: "inactive")
    User.countDocuments({ isDeleted: false, status: "inactive" }),

    // 5. Today Users (Created since start of today)
    User.countDocuments({ createdAt: { $gte: startOfDay } }),

    // 6. Week Users (Created in last 7 days)
    User.countDocuments({ createdAt: { $gte: startOfWeek } }),

    // 7. Total Subscribed users (users with isSubscription: true AND not deleted)
    User.countDocuments({ isSubscription: true, isDeleted: false }),

    // 8. Total Subscription Active users (active subscription status)
    Subscription.countDocuments({ status: "active" }),

    // 9. Total Subscription Inactive users (incomplete, pending, in_progress, etc.)
    Subscription.countDocuments({
      status: {
        $in: ["incomplete", "in_progress", "past_due", "unpaid", "trialing"]
      }
    }),

    // 10. Total Posts (only NON-DELETED posts - isDeleted: false)
    Post.countDocuments({ isDeleted: false }),

    // 11. Total News (all news, assuming news doesn't have isDeleted field)
    News.countDocuments(),

    // Monthly total users graph data (ALL users including deleted for accurate growth tracking)
    User.aggregate([
      {
        $match: {
          createdAt: { $gte: startOfYear }
        }
      },
      {
        $group: {
          _id: {
            year: { $year: "$createdAt" },
            month: { $month: "$createdAt" }
          },
          count: { $sum: 1 }
        }
      },
      {
        $sort: { "_id.year": 1, "_id.month": 1 }
      }
    ]),

    // Monthly active users graph data
    User.aggregate([
      {
        $match: {
          createdAt: { $gte: startOfYear },
          isDeleted: false,
          status: "active"
        }
      },
      {
        $group: {
          _id: {
            year: { $year: "$createdAt" },
            month: { $month: "$createdAt" }
          },
          count: { $sum: 1 }
        }
      },
      {
        $sort: { "_id.year": 1, "_id.month": 1 }
      }
    ]),

    // Monthly inactive users graph data
    User.aggregate([
      {
        $match: {
          createdAt: { $gte: startOfYear },
          isDeleted: false,
          status: "inactive"
        }
      },
      {
        $group: {
          _id: {
            year: { $year: "$createdAt" },
            month: { $month: "$createdAt" }
          },
          count: { $sum: 1 }
        }
      },
      {
        $sort: { "_id.year": 1, "_id.month": 1 }
      }
    ])
  ]);

  // Format monthly data for graphs
  const currentYear = now.getFullYear();
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  const formatMonthlyData = (data) => {
    return months.map((monthName, index) => {
      const monthNumber = index + 1;
      const found = data.find(
        (d) => d._id.year === currentYear && d._id.month === monthNumber
      );
      return { month: monthName, count: found ? found.count : 0 };
    });
  };

  const monthlyTotalGraph = formatMonthlyData(monthlyTotalData);
  const monthlyActiveGraph = formatMonthlyData(monthlyActiveData);
  const monthlyInactiveGraph = formatMonthlyData(monthlyInactiveData);

  // Prepare response data
  const data = {
    users: {
      total: totalUsers,
      deleted: totalDeletedUsers,
      active: totalActiveUsers,
      inactive: totalInactiveUsers,
      today: todayUsers,
      week: weekUsers
    },
    subscriptions: {
      totalSubscribedUsers: totalSubscribedUsers,
      activeSubscriptions: totalSubscriptionActiveUsers,
      inactiveSubscriptions: totalSubscriptionInactiveUsers
    },
    content: {
      posts: totalPosts,
      news: totalNews
    },
    graphs: {
      monthly: {
        total: monthlyTotalGraph,
        active: monthlyActiveGraph,
        inactive: monthlyInactiveGraph
      }
    }
  };

  return successResponse(res, "Admin analytics retrieved successfully", data);
});