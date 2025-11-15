import User from "../models/User.js";
import ChatRequest from "../models/ChatRequest.js";
import ChatConversation from "../models/ChatConversation.js";
import { getIO } from "../config/socket.js";
import mongoose from "mongoose";
import redisClient from "../config/redis.js";

/**
 * Check if a user is deleted and return deleted user info
 * @param {string} userId - User ID to check
 * @returns {Promise<{isDeleted: boolean, user: Object|null}>}
 */
export const checkUserDeleted = async (userId) => {
  if (!userId) return { isDeleted: false, user: null };
  
  try {
    const user = await User.findById(userId).select("isDeleted firstname lastname email profileimg");
    if (!user) return { isDeleted: false, user: null };
    
    return {
      isDeleted: user.isDeleted === true,
      user: user.isDeleted ? {
        _id: String(user._id),
        firstname: "Profile",
        lastname: "Deleted",
        email: "",
        profileimg: "/uploads/default.png",
        isDeleted: true
      } : user
    };
  } catch (error) {
    console.error("Error checking user deleted status:", error);
    return { isDeleted: false, user: null };
  }
};

/**
 * Remove deleted users from groups automatically
 * If the group creator/admin is deleted, delete the entire group
 * @param {string} userId - User ID that was deleted
 */
export const removeDeletedUserFromGroups = async (userId) => {
  try {
    // Find all groups where user is a member
    const groups = await ChatRequest.find({
      chatType: "group",
      receiverId: null,
      $or: [
        { groupAdmin: userId },
        { superAdmins: userId },
        { members: userId }
      ]
    });

    const io = getIO();

    for (const group of groups) {
      // ✅ If user is the group creator/admin, delete the entire group
      if (String(group.groupAdmin) === String(userId)) {
        // Collect all group member IDs before deletion for notifications
        const allGroupMemberIds = [
          String(group.groupAdmin),
          ...(group.superAdmins || []).map(String),
          ...(group.members || []).map(String)
        ].filter(Boolean);

        // Delete pending invitations
        await ChatRequest.deleteMany({
          groupId: group._id,
          status: "pending"
        });

        // Delete the group root
        await ChatRequest.findByIdAndDelete(group._id);

        // ✅ EMIT SOCKET EVENT FOR GROUP DELETED
        allGroupMemberIds.forEach((memberId) => {
          io.to(`user:${memberId}`).emit("chatList:update", {
            chatId: String(group._id),
            action: "groupDeleted",
            type: "group",
            reason: "creatorDeleted"
          });
          io.to(`user:${memberId}`).emit("chatRequests:update");
        });

        // Clear cache for all group members
        try {
          const cacheKeys = allGroupMemberIds.flatMap(uid => [
            `requests:${uid}:group`,
            `requests:${uid}:accepted`
          ]);
          await redisClient.del(cacheKeys);
        } catch (err) {
          console.warn("⚠️ Redis delete failed:", err.message);
        }

        console.log(`✅ Deleted group ${group._id} because creator ${userId} was deleted`);
        continue; // Skip to next group
      }

      // ✅ If user is not the creator, just remove them from members/superAdmins
      let updated = false;

      // Remove from members array
      if (group.members && Array.isArray(group.members)) {
        const originalLength = group.members.length;
        group.members = group.members.filter(
          (m) => String(m) !== String(userId)
        );
        if (group.members.length !== originalLength) {
          updated = true;
        }
      }

      // Remove from superAdmins array
      if (group.superAdmins && Array.isArray(group.superAdmins)) {
        const originalLength = group.superAdmins.length;
        group.superAdmins = group.superAdmins.filter(
          (a) => String(a) !== String(userId)
        );
        if (group.superAdmins.length !== originalLength) {
          updated = true;
        }
      }

      if (updated) {
        await group.save();

        // Collect all group member IDs for notification
        const allGroupMemberIds = [
          String(group.groupAdmin),
          ...(group.superAdmins || []).map(String),
          ...(group.members || []).map(String)
        ].filter(Boolean);

        // Emit socket event to notify remaining members
        allGroupMemberIds.forEach((memberId) => {
          io.to(`user:${memberId}`).emit("chatList:update", {
            chatId: String(group._id),
            action: "memberRemoved",
            type: "group",
            removedUserId: String(userId),
            reason: "userDeleted"
          });
          io.to(`user:${memberId}`).emit("chatRequests:update");
        });

        // Also emit to the deleted user
        io.to(`user:${userId}`).emit("chatList:update", {
          chatId: String(group._id),
          action: "removedFromGroup",
          type: "group",
          reason: "userDeleted"
        });

        console.log(`✅ Removed deleted user ${userId} from group ${group._id}`);
      }
    }
  } catch (error) {
    console.error("Error removing deleted user from groups:", error);
  }
};

/**
 * Restore user to groups when isDeleted becomes false
 * Note: This doesn't automatically re-add them, but allows them to be visible again
 * @param {string} userId - User ID that was restored
 */
export const handleUserRestored = async (userId) => {
  try {
    // When user is restored, we don't automatically re-add them to groups
    // They would need to be re-invited or re-added by group admin
    // But we can emit socket events to update chat lists
    const io = getIO();
    
    io.to(`user:${userId}`).emit("chatList:update", {
      action: "userRestored",
      type: "all"
    });
    
    console.log(`✅ User ${userId} restored - chat lists updated`);
  } catch (error) {
    console.error("Error handling user restore:", error);
  }
};

