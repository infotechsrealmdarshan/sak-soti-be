import User from "../models/User.js";
import { asyncHandler } from "../utils/errorHandler.js";
import { successResponse } from "../utils/response.js";

export const getAdminAnalytics = asyncHandler(async (req, res) => {
  const now = new Date();
  
  // Time ranges
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay()); // Start of current week (Sunday)
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfYear = new Date(now.getFullYear(), 0, 1);
  
  // Previous periods for comparison
  const startOfPreviousDay = new Date(startOfDay);
  startOfPreviousDay.setDate(startOfDay.getDate() - 1);
  
  const startOfPreviousMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const endOfPreviousMonth = new Date(now.getFullYear(), now.getMonth(), 0);
  
  const startOfPreviousYear = new Date(now.getFullYear() - 1, 0, 1);
  const endOfPreviousYear = new Date(now.getFullYear() - 1, 11, 31);

  // Execute all queries in parallel for better performance
  const [
    totalUsers,
    todayUsers,
    weekUsers,
    monthUsers,
    yearUsers,
    previousDayUsers,
    previousMonthUsers,
    previousYearUsers,
    monthlyData,
    yearlyData
  ] = await Promise.all([
    // Current period counts
    User.countDocuments(),
    User.countDocuments({ createdAt: { $gte: startOfDay } }),
    User.countDocuments({ createdAt: { $gte: startOfWeek } }),
    User.countDocuments({ createdAt: { $gte: startOfMonth } }),
    User.countDocuments({ createdAt: { $gte: startOfYear } }),
    
    // Previous period counts for comparison
    User.countDocuments({ 
      createdAt: { 
        $gte: startOfPreviousDay, 
        $lt: startOfDay 
      } 
    }),
    User.countDocuments({ 
      createdAt: { 
        $gte: startOfPreviousMonth, 
        $lte: endOfPreviousMonth 
      } 
    }),
    User.countDocuments({ 
      createdAt: { 
        $gte: startOfPreviousYear, 
        $lte: endOfPreviousYear 
      } 
    }),
    
    // Monthly data for current year
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
            month: { $month: "$createdAt" },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { "_id.year": 1, "_id.month": 1 } },
    ]),
    
    // Yearly data
    User.aggregate([
      {
        $group: {
          _id: {
            year: { $year: "$createdAt" },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { "_id.year": 1 } },
    ]),
  ]);

  // Calculate growth percentages
  const calculateGrowth = (current, previous) => {
    if (previous === 0) return current > 0 ? 100 : 0;
    return ((current - previous) / previous * 100).toFixed(1);
  };

  // Format monthly data for current year
  const currentYear = now.getFullYear();
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
  ];
  
  const monthlyGraph = months.map((monthName, index) => {
    const monthNumber = index + 1;
    const found = monthlyData.find(
      (d) => d._id.year === currentYear && d._id.month === monthNumber
    );
    return {
      month: monthName,
      count: found ? found.count : 0,
    };
  });

  // Format yearly data
  const yearlyGraph = yearlyData.map(item => ({
    year: item._id.year,
    count: item.count
  })).sort((a, b) => a.year - b.year);

  // Prepare response data
  const data = {
    summary: {
      totalUsers,
      todayUsers,
      weekUsers,
      monthUsers,
      yearUsers
    },
    growth: {
      daily: calculateGrowth(todayUsers, previousDayUsers),
      monthly: calculateGrowth(monthUsers, previousMonthUsers),
      yearly: calculateGrowth(yearUsers, previousYearUsers)
    },
    graphs: {
      monthly: monthlyGraph,
      yearly: yearlyGraph
    },
    previousPeriods: {
      day: previousDayUsers,
      month: previousMonthUsers,
      year: previousYearUsers
    }
  };

  return successResponse(res, "Admin analytics retrieved successfully", data);
});