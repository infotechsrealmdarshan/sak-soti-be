import User from "../models/User.js";
import { asyncHandler } from "../utils/errorHandler.js";
import { successResponse } from "../utils/response.js";
import mongoose from "mongoose";

export const getAdminAnalytics = asyncHandler(async (req, res) => {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfYear = new Date(now.getFullYear(), 0, 1);


  const [totalUsers, todayUsers, monthUsers, yearUsers, monthlyData] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({ createdAt: { $gte: startOfDay } }),
    User.countDocuments({ createdAt: { $gte: startOfMonth } }),
    User.countDocuments({ createdAt: { $gte: startOfYear } }),
    User.aggregate([
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
  ]);


  const year = now.getFullYear();
  const months = Array.from({ length: 12 }, (_, i) => i + 1);
  const monthlyGraph = months.map((m) => {
    const found = monthlyData.find(
      (d) => d._id.year === year && d._id.month === m
    );
    return {
      month: m,
      count: found ? found.count : 0,
    };
  });


  const data = {
    totalUsers,
    todayUsers,
    monthUsers,
    yearUsers,
    monthlyGraph,
  };

  return successResponse(res, "Admin analytics retrieved successfully", data);
});
