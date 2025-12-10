import ChatRequest from "../../models/ChatRequest.js";
import User from "../../models/User.js";
import Post from "../../models/Post.js";
import { asyncHandler } from "../../utils/errorHandler.js";
import { errorResponse, successResponse } from "../../utils/response.js";
import { getIO } from "../../config/socket.js";
import Notification from "../../models/Notification.js";
import { sendFirebaseNotification } from "../../utils/firebaseHelper.js";
import mongoose from "mongoose";
import redisClient from "../../config/redis.js";
import ChatConversation from "../../models/ChatConversation.js";
import { removeDeletedUserFromGroups } from "../../utils/chatHelper.js";
import logger from "../../utils/logger.js";

// Helper function to delete Redis keys by pattern
const deleteRedisKeysByPattern = async (pattern) => {
  if (!redisClient || typeof redisClient.scan !== "function") return;
  try {
    let cursor = "0";
    do {
      const [nextCursor, keys] = await redisClient.scan(cursor, "MATCH", pattern, "COUNT", 50);
      cursor = nextCursor;
      if (Array.isArray(keys) && keys.length > 0) {
        await redisClient.del(...keys);
      }
    } while (cursor !== "0");
  } catch (err) {
    logger.warn(`Redis delete failed for pattern ${pattern}:`, err.message);
  }
};

export const getEligibleUsersForGroup = asyncHandler(async (req, res) => {
  const userId = req.user?.id;
  const myPostsCount = await Post.countDocuments({ author: userId });
  if (myPostsCount > 2) {
    return successResponse(res, "You have uploaded more than 2 posts. Eligible users list is not available.", null, null, 200, 0);
  }

  const users = await User.find({ _id: { $ne: userId }, $or: [{ isSubscription: true }, { isAdmin: true }] })
    .select("firstname lastname email profileimg isSubscription isAdmin")
    .sort({ createdAt: -1 })
    .limit(100);

  return successResponse(res, "Eligible users fetched", users, null, 200, 1);
});

export const createGroupViaJson = asyncHandler(async (req, res) => {
  const creatorId = req.user?.id;
  let { name, memberIds, image } = req.body;
  const file = req.file;
  let groupImage = null;

  // ✅ Handle image from file upload (multipart/form-data)
  if (file) {
    groupImage = `/uploads/${file.filename}`;
  }
  // ✅ Handle image URL from JSON body (application/json)
  else if (image && typeof image === 'string' && image.trim()) {
    groupImage = image.trim();
  }

  if (!creatorId) return errorResponse(res, "Unauthorized", 404);

  // ✅ Handle memberIds when coming as JSON string from form-data
  if (typeof memberIds === 'string') {
    try {
      memberIds = JSON.parse(memberIds);
    } catch (err) {
      return errorResponse(
        res,
        "memberIds must be a valid JSON array",
        404
      );
    }
  }

  // ✅ Require creator to have uploaded at least 2 posts
  const creatorPosts = await Post.countDocuments({ author: creatorId });
  if (creatorPosts < 2) {
    return successResponse(
      res,
      "You must have at least 2 posts to create a group.",
      null,
      null,
      200,
      0
    );
  }

  // ✅ Validate memberIds array
  if (!Array.isArray(memberIds) || memberIds.length === 0) {
    return errorResponse(
      res,
      "memberIds must be a non-empty array of user IDs",
      404
    );
  }

  // ✅ Clean up and deduplicate IDs
  const inputIds = Array.from(
    new Set(memberIds.map((v) => String(v).trim()).filter(Boolean))
  );

  // ✅ Exclude creator explicitly from inputIds (compare as strings to handle type mismatches)
  const creatorIdStr = String(creatorId);
  const filteredInputIds = inputIds.filter((id) => String(id) !== creatorIdStr);

  // ✅ Fetch users and validate existence
  const users = await User.find({ _id: { $in: filteredInputIds } }).select(
    "_id firstname lastname isSubscription isAdmin"
  );

  if (users.length !== filteredInputIds.length) {
    return successResponse(
      res,
      "One or more user ids not found",
      null,
      null,
      200,
      0
    );
  }

  // ✅ Check that all users are subscribed or admins
  const allSubscribed = users.every((u) => !!u.isSubscription || !!u.isAdmin);
  if (!allSubscribed) {
    return successResponse(
      res,
      "All members must have an active subscription to be added to a group.",
      null,
      null,
      200,
      0
    );
  }

  // ✅ Fetch accepted chats between creator and requested members
  const creatorIdForQuery = mongoose.Types.ObjectId.isValid(creatorId)
    ? new mongoose.Types.ObjectId(creatorId)
    : creatorId;

  const filteredInputIdsForQuery = filteredInputIds.map(id => {
    return mongoose.Types.ObjectId.isValid(id)
      ? new mongoose.Types.ObjectId(id)
      : id;
  });

  // Check for accepted individual chats
  const acceptedIndividualChats = await ChatRequest.find({
    chatType: "individual",
    status: "accepted",
    $or: [
      { senderId: creatorIdForQuery, receiverId: { $in: filteredInputIdsForQuery } },
      { receiverId: creatorIdForQuery, senderId: { $in: filteredInputIdsForQuery } },
    ],
  }).select("senderId receiverId");

  // Check for previously accepted group invitations
  const acceptedGroupInvitations = await ChatRequest.find({
    chatType: "group",
    status: "accepted",
    senderId: creatorIdForQuery,
    receiverId: { $in: filteredInputIdsForQuery },
  }).select("senderId receiverId");

  // Check previous group memberships
  const previousGroupMemberships = await ChatRequest.find({
    chatType: "group",
    receiverId: null,
    senderId: creatorIdForQuery,
    $or: [
      { members: { $in: filteredInputIdsForQuery } },
      { superAdmins: { $in: filteredInputIdsForQuery } }
    ]
  }).select("members superAdmins");

  const previousGroupMemberIds = new Set();
  previousGroupMemberships.forEach(group => {
    (group.members || []).forEach(memberId => {
      const memberIdStr = String(memberId);
      if (filteredInputIds.includes(memberIdStr)) {
        previousGroupMemberIds.add(memberIdStr);
      }
    });
    (group.superAdmins || []).forEach(adminId => {
      const adminIdStr = String(adminId);
      if (filteredInputIds.includes(adminIdStr)) {
        previousGroupMemberIds.add(adminIdStr);
      }
    });
  });

  const previousGroupMemberIdsArray = Array.from(previousGroupMemberIds);
  if (previousGroupMemberIdsArray.length > 0) {
    logger.log("Users found in previous groups (adding directly):", previousGroupMemberIdsArray);
  }

  const acceptedChats = [...acceptedIndividualChats, ...acceptedGroupInvitations];
  const acceptedMemberIdsFromChats = acceptedChats.map((chat) => {
    const senderIdStr = String(chat.senderId);
    const receiverIdStr = String(chat.receiverId);
    const creatorIdStrForCompare = String(creatorId);
    return senderIdStr === creatorIdStrForCompare ? receiverIdStr : senderIdStr;
  });

  const acceptedMemberIds = Array.from(new Set([
    ...acceptedMemberIdsFromChats,
    ...previousGroupMemberIdsArray
  ]));

  if (acceptedMemberIds.length > 0) {
    logger.log(`Found ${acceptedMemberIds.length} users with accepted chats:`, acceptedMemberIds);
  }

  const acceptedMemberIdsSet = new Set(acceptedMemberIds.map(id => String(id)));
  const initialConfirmedMembers = Array.from(new Set([
    String(creatorId),
    ...Array.from(acceptedMemberIdsSet)
  ]));

  const initialInvitationIds = filteredInputIds.filter(
    (id) => {
      const idStr = String(id);
      return !acceptedMemberIdsSet.has(idStr) && idStr !== creatorIdStr;
    }
  );

  const creator = await User.findById(creatorId).select("firstname lastname isAdmin");
  if (!creator) {
    return errorResponse(res, "Creator user not found", 404);
  }

  const initialInvitationIdsObjectIds = initialInvitationIds.map(id => {
    try {
      return mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : id;
    } catch {
      return id;
    }
  });

  const invitationUsersData = await User.find({ _id: { $in: initialInvitationIdsObjectIds } })
    .select("_id isAdmin");

  const adminIdsFromInvitations = invitationUsersData
    .filter((user) => user.isAdmin === true)
    .map((user) => user._id.toString());

  if (adminIdsFromInvitations.length > 0) {
    logger.log("Admins found from invitations and added directly:", adminIdsFromInvitations);
  }

  let confirmedMembers = Array.from(new Set([...initialConfirmedMembers, ...adminIdsFromInvitations]));
  const invitationIds = initialInvitationIds.filter(
    (id) => !adminIdsFromInvitations.includes(String(id))
  );

  const allSuperAdminUsers = await User.find({ isAdmin: true })
    .select("_id isAdmin")
    .sort({ createdAt: 1 });

  let superAdminsList = [];
  if (allSuperAdminUsers && allSuperAdminUsers.length > 0) {
    allSuperAdminUsers.forEach(superAdminUser => {
      const superAdminId = String(superAdminUser._id);
      if (!confirmedMembers.includes(superAdminId)) {
        confirmedMembers.push(superAdminId);
      }
    });
    confirmedMembers = Array.from(new Set(confirmedMembers));
    superAdminsList = allSuperAdminUsers.map(admin => admin._id);
    logger.log(`Found ${allSuperAdminUsers.length} super admin(s) and added:`, superAdminsList.map(id => String(id)));
  } else {
    logger.log("No super admin found in database");
  }

  let groupName = String(name || "").trim();
  if (!groupName) {
    const displayNames = [creator, ...users]
      .filter(Boolean)
      .map((u) => `${u.firstname || ""} ${u.lastname || ""}`.trim())
      .filter(Boolean);
    groupName = displayNames.join(", ");
  }

  const group = await ChatRequest.create({
    senderId: creatorId,
    receiverId: null,
    chatType: "group",
    status: "accepted",
    groupId: undefined,
    name: groupName,
    groupAdmin: creatorId,
    superAdmins: superAdminsList,
    members: confirmedMembers.filter(id =>
      String(id) !== String(creatorId) &&
      !superAdminsList.map(String).includes(String(id))
    ),
    pendingMembers: [],
    groupImage: groupImage,
  });

  if (!group.groupId) {
    group.groupId = group._id;
    await group.save();
  }

  const finalInvitationIds = invitationIds.filter(
    (id) => String(id) !== creatorIdStr
  );

  const invitationRequests = [];
  for (const inviteeId of finalInvitationIds) {
    if (String(inviteeId) === creatorIdStr) continue;

    const existingInvite = await ChatRequest.findOne({
      senderId: creatorId,
      receiverId: inviteeId,
      chatType: "group",
      groupId: group._id,
      status: "pending"
    });

    if (!existingInvite) {
      const invite = await ChatRequest.create({
        senderId: creatorId,
        receiverId: inviteeId,
        chatType: "group",
        status: "pending",
        groupId: group._id,
      });
      invitationRequests.push(invite);
    }
  }

  try {
    const creator = await User.findById(creatorId).select("firstname lastname email");
    const creatorName = `${creator.firstname || ""} ${creator.lastname || ""}`.trim() || creator.email;
    const io = getIO();

    const titleAdded = "Added to Group";
    const titleInvited = "Group Invitation";
    const groupNameForNotification = group.name || "New Group";

    const directAddedMembers = confirmedMembers.filter(id => String(id) !== String(creatorId));
    for (const memberId of directAddedMembers) {
      const member = await User.findById(memberId).select("fcmToken email");
      if (!member) continue;

      const body = `${creatorName} added you to group "${groupNameForNotification}".`;
      const notification = await Notification.create({
        userId: member._id,
        title: titleAdded,
        message: body,
        deeplink: "",
      });

      if (member.fcmToken) {
        const pushResult = await sendFirebaseNotification(
          member.fcmToken,
          titleAdded,
          body,
          { type: "group_added", chatId: group._id.toString(), senderId: creatorId }
        );
        notification.firebaseStatus = pushResult.success ? "sent" : "failed";
        await notification.save();
      }

      io.to(`user:${memberId}`).emit("group:added", { groupId: group._id, groupName: groupNameForNotification });
    }

    for (const invite of invitationRequests) {
      const invitee = await User.findById(invite.receiverId).select("fcmToken email");
      if (!invitee) continue;

      const body = `${creatorName} invited you to join group "${groupNameForNotification}".`;
      const notification = await Notification.create({
        userId: invitee._id,
        title: titleInvited,
        message: body,
        deeplink: "",
      });

      if (invitee.fcmToken) {
        const pushResult = await sendFirebaseNotification(
          invitee.fcmToken,
          titleInvited,
          body,
          { type: "group_invitation", chatId: group._id.toString(), senderId: creatorId }
        );
        notification.firebaseStatus = pushResult.success ? "sent" : "failed";
        await notification.save();
      }

      io.to(`user:${invite.receiverId}`).emit("group:invited", { groupId: group._id, groupName: groupNameForNotification });
    }
  } catch (err) {
    logger.error("❌ Error sending group create notifications:", err.message);
  }

  const populated = await ChatRequest.findById(group._id)
    .populate({ path: "groupAdmin", select: "firstname lastname email isAdmin profileimg" })
    .populate({ path: "superAdmins", select: "firstname lastname email isAdmin profileimg" })
    .populate({ path: "members", select: "firstname lastname email profileimg" });

  try {
    const initialParticipantIds = new Set();
    initialParticipantIds.add(String(creatorId));
    confirmedMembers.forEach(id => initialParticipantIds.add(String(id)));
    (superAdminsList || []).forEach(id => initialParticipantIds.add(String(id)));

    const joinedAtUpdate = {};
    const participantsUpdate = Array.from(initialParticipantIds);
    const joinedAtDate = new Date();
    participantsUpdate.forEach(id => {
      joinedAtUpdate[`joinedAtByUser.${id}`] = joinedAtDate;
    });

    await ChatConversation.findOneAndUpdate(
      { chatRequestId: group._id },
      {
        $set: {
          ...joinedAtUpdate,
          participants: participantsUpdate,
          chatType: "group"
        }
      },
      { upsert: true }
    );
  } catch (err) {
    logger.warn("⚠️ Failed to record initial group join times:", err.message);
  }

  // ✅ Format response to match group retrieval API format
  const populatedCreatorIdStr = populated.groupAdmin?._id?.toString();
  const adminIdSet = new Set(
    (populated.superAdmins || []).map((a) => a._id.toString())
  );

  // ✅ Get all members including creator for display
  const allDisplayMembers = [
    ...(populated.members || []),
    populated.groupAdmin
  ].filter(Boolean);

  // Filter out deleted users and super admins (but keep creator)
  const filteredMembers = allDisplayMembers.filter((m) => {
    if (!m) return false;
    if (m.isDeleted === true) return false;

    const mid = m._id.toString();
    return !adminIdSet.has(mid) || mid === populatedCreatorIdStr;
  });

  // ✅ Add userType to each member
  const enhancedMembers = filteredMembers.map(member => {
    const memberIdStr = String(member._id);
    let userType = 'member';

    if (memberIdStr === populatedCreatorIdStr) {
      userType = 'creator';
    } else if (adminIdSet.has(memberIdStr)) {
      userType = 'superAdmin';
    }

    return {
      _id: member._id,
      firstname: member.firstname || "",
      lastname: member.lastname || "",
      email: member.email || "",
      profileimg: member.profileimg || "/uploads/default.png",
      isDeleted: member.isDeleted || false,
      isAdmin: member.isAdmin || false,
      userType: userType
    };
  });

  // Create the response object
  const responseData = {
    _id: populated._id,
    senderId: populated.senderId,
    receiverId: null,
    chatType: "group",
    status: "accepted",
    name: populated.name,
    groupImage: populated.groupImage,
    members: enhancedMembers,
    pendingMembers: populated.pendingMembers || [],
    isSystemGroup: populated.isSystemGroup || false,
    messages: populated.messages || [],
    createdAt: populated.createdAt,
    updatedAt: populated.updatedAt,
    __v: populated.__v,
    groupId: populated.groupId,
    groupName: populated.name || "Group"
  };

  // Remove unnecessary fields
  delete responseData.groupAdmin;
  delete responseData.superAdmins;

  // ✅ Compute counts
  const uniqueAdminIds = new Set(
    [
      populated.groupAdmin?._id?.toString(),
      ...(populated.superAdmins || []).map((a) => a._id.toString()),
    ].filter(Boolean)
  );

  // ✅ Build final response with counts
  const finalInvitationsList = finalInvitationIds.filter(
    (id) => String(id) !== creatorIdStr
  );

  const responseWithExtras = {
    ...responseData,
    counts: {
      creatorCount: populated.groupAdmin ? 1 : 0,
      adminsCount: uniqueAdminIds.size,
      membersCount: enhancedMembers.length,
    },
    invitations: finalInvitationsList,
  };

  // ✅ Clear Redis cache
  try {
    if (redisClient) {
      const cacheKeys = [
        `requests:${String(creatorId)}:group:*`,
        `requests:${String(creatorId)}:accepted:*`
      ];

      const allUserIds = [
        ...confirmedMembers,
        ...finalInvitationsList
      ];

      allUserIds.forEach(userId => {
        if (String(userId) !== creatorIdStr) {
          cacheKeys.push(`requests:${String(userId)}:group:*`);
          cacheKeys.push(`requests:${String(userId)}:received:*`);
          cacheKeys.push(`requests:${String(userId)}:accepted:*`);
        }
      });

      await Promise.all([
        ...cacheKeys.map(pattern => deleteRedisKeysByPattern(pattern)),
        redisClient.del([`requests:${String(creatorId)}:group`])
      ]);
    }
  } catch (err) {
    logger.warn("⚠️ Redis clear error:", err.message);
  }

  // ✅ EMIT SOCKET EVENT FOR GROUP CREATED
  try {
    const io = getIO();
    const allGroupMemberIds = [
      String(creatorId),
      ...confirmedMembers.filter(id => String(id) !== String(creatorId))
    ];

    // Format socket data to match group retrieval format
    const socketGroupData = {
      _id: String(group._id),
      senderId: {
        _id: creatorId,
        firstname: creator.firstname,
        lastname: creator.lastname,
        email: creator.email,
        profileimg: creator.profileimg || "/uploads/default.png",
        isDeleted: false
      },
      receiverId: null,
      chatType: "group",
      name: group.name,
      groupImage: group.groupImage,
      members: enhancedMembers,
      membersCount: enhancedMembers.length,
      groupName: group.name || "Group",
      createdAt: group.createdAt,
      updatedAt: group.updatedAt
    };

    allGroupMemberIds.forEach(memberId => {
      io.to(`user:${memberId}`).emit("chatList:update", {
        chatId: String(group._id),
        action: "groupCreated",
        type: "group",
        groupData: socketGroupData
      });
      io.to(`user:${memberId}`).emit("chatRequests:update");
    });

    logger.log(`📡 Group created socket events emitted for group ${group._id}`);
  } catch (err) {
    logger.error("Socket emit error (group created):", err.message);
  }

  // ✅ Final response - matches group retrieval format
  return successResponse(res, "Group created", responseWithExtras, null, 200, 1);
});

export const updateGroupByCreator = asyncHandler(async (req, res) => {
  const creatorId = req.user?.id;
  const { groupId, memberIds = [] } = req.body; // Removed 'type' parameter

  if (!creatorId) return errorResponse(res, "Unauthorized", 404);
  if (!groupId) return errorResponse(res, "groupId is required", 404);
  if (!Array.isArray(memberIds)) {
    return errorResponse(res, "memberIds must be an array", 404);
  }

  // Validate MongoDB ObjectId
  if (!mongoose.Types.ObjectId.isValid(groupId)) {
    return successResponse(res, "Group id not found", null, null, 200, 0);
  }

  const group = await ChatRequest.findOne({ _id: groupId, chatType: 'group', receiverId: null });
  if (!group) return successResponse(res, "Group id not found", null, null, 200, 0);

  if (String(group.groupAdmin) !== String(creatorId)) {
    return successResponse(res, "Only the creator can update the group", null, null, 200, 0);
  }

  const creator = await User.findById(creatorId).select("firstname lastname email");
  const creatorName = `${creator.firstname || ""} ${creator.lastname || ""}`.trim() || creator.email;

  // ✅ Auto-filter: Remove creator, admins, and superAdmins from memberIds
  const adminIds = new Set([
    String(group.groupAdmin),
    ...(group.superAdmins || []).map(String)
  ]);

  const filteredMemberIds = Array.from(new Set(memberIds.map(String)))
    .filter(uid => !adminIds.has(uid)); // Exclude admins and creator

  // ✅ Get current members (excluding admins)
  const currentMembers = new Set(
    (group.members || [])
      .map(String)
      .filter(uid => !adminIds.has(uid))
  );

  // ✅ Auto-detect: Determine who to add and who to remove
  const newMemberIds = new Set(filteredMemberIds);

  const toAdd = filteredMemberIds.filter(uid => !currentMembers.has(uid));
  const toRemove = Array.from(currentMembers).filter(uid => !newMemberIds.has(uid));

  // If nothing to do, return early
  if (toAdd.length === 0 && toRemove.length === 0) {
    return successResponse(res, "No changes to make", null, null, 200, 0);
  }

  let addedUsers = [];
  let removedUsers = [];

  // ✅ Handle ADDITIONS
  if (toAdd.length > 0) {
    const users = await User.find({ _id: { $in: toAdd } }).select("_id firstname lastname email fcmToken isSubscription isAdmin");
    if (users.length !== toAdd.length) {
      return successResponse(res, "One or more user ids not found", null, null, 200, 0);
    }

    const allSubscribed = users.every(u => !!u.isSubscription || !!u.isAdmin);
    if (!allSubscribed) {
      return successResponse(res, "All members must have an active subscription.", null, null, 200, 0);
    }

    // Add new members
    for (const uid of toAdd) currentMembers.add(uid);
    addedUsers = users;

    // ✅ Record join time for new members
    try {
      const joinedAtDate = new Date();
      const joinedAtUpdate = {};
      toAdd.forEach(id => {
        joinedAtUpdate[`joinedAtByUser.${String(id)}`] = joinedAtDate;
      });
      const participantSet = new Set(Array.from(currentMembers).map(String));
      participantSet.add(String(group.groupAdmin));
      (group.superAdmins || []).forEach(id => participantSet.add(String(id)));
      await ChatConversation.findOneAndUpdate(
        { chatRequestId: group._id },
        {
          $set: {
            ...joinedAtUpdate,
            participants: Array.from(participantSet)
          },
          $setOnInsert: { chatType: "group" }
        },
        { upsert: true }
      );
    } catch (err) {
      logger.warn("⚠️ Failed to record join time for added members:", err.message);
    }
  }

  // ✅ Handle REMOVALS
  if (toRemove.length > 0) {
    removedUsers = await User.find({ _id: { $in: toRemove } })
      .select("_id firstname lastname email fcmToken");

    // Remove from currentMembers set
    toRemove.forEach(uid => currentMembers.delete(uid));
  }

  // ✅ Update group members (Store ONLY regular members, exclude admins/creator)
  // User requested to remove admin data from 'members' array
  group.members = Array.from(currentMembers);

  await group.save();


  // ✅ EMIT SOCKET EVENTS
  try {
    const io = getIO();
    const allGroupMemberIds = [
      String(group.groupAdmin),
      ...(group.superAdmins || []).map(String),
      ...(group.members || []).map(String)
    ];

    // Notify all current group members about the update
    if (toAdd.length > 0 || toRemove.length > 0) {
      allGroupMemberIds.forEach(memberId => {
        io.to(`user:${memberId}`).emit("chatList:update", {
          chatId: String(group._id),
          action: toAdd.length > 0 ? "membersAdded" : "membersRemoved",
          type: "group",
          addedMemberIds: toAdd,
          removedMemberIds: toRemove
        });
        io.to(`user:${memberId}`).emit("chatRequests:update");
      });
    }

    // Notify removed members
    if (toRemove.length > 0) {
      toRemove.forEach(removedId => {
        io.to(`user:${removedId}`).emit("chatList:update", {
          chatId: String(group._id),
          action: "removedFromGroup",
          type: "group"
        });
        io.to(`user:${removedId}`).emit("chatRequests:update");
      });
    }

    logger.log(`📡 Group update socket events emitted for group ${group._id}`);
  } catch (err) {
    logger.error("Socket emit error (group update):", err.message);
  }

  // 🔔 Send notifications to newly added users
  for (const user of addedUsers) {
    try {
      const title = "Added to Group";
      const message = `${creatorName} added you to the group "${group.name || "Group"}".`;

      const notification = await Notification.create({
        userId: user._id,
        title,
        message,
        deeplink: "",
      });

      if (user.fcmToken) {
        const pushResult = await sendFirebaseNotification(
          user.fcmToken,
          title,
          message,
          { type: "group_add", chatId: group._id.toString(), senderId: creatorId }
        );

        notification.firebaseStatus = pushResult.success ? "sent" : "failed";
        await notification.save();

        if (pushResult.success) {
          logger.log(`✅ Added-to-group notification sent to ${user.email}`);
        } else {
          logger.error(`⚠️ Firebase send failed: ${pushResult.error}`);
          if (pushResult.error.includes("invalid-registration-token")) {
            await User.findByIdAndUpdate(user._id, { $unset: { fcmToken: 1 } });
          }
        }
      }
    } catch (err) {
      logger.error("❌ Error sending add notification:", err.message);
    }
  }

  // 🔔 Notify removed users
  for (const user of removedUsers) {
    try {
      const title = "Removed from Group";
      const message = `You have been removed from the group "${group.name || "Group"}" by ${creatorName}.`;

      const notification = await Notification.create({
        userId: user._id,
        title,
        message,
        deeplink: "",
      });

      if (user.fcmToken) {
        const pushResult = await sendFirebaseNotification(
          user.fcmToken,
          title,
          message,
          { type: "group_remove", chatId: group._id.toString(), senderId: creatorId }
        );

        notification.firebaseStatus = pushResult.success ? "sent" : "failed";
        await notification.save();

        if (pushResult.success) {
          logger.log(`✅ Removal notification sent to ${user.email}`);
        } else {
          logger.error(`⚠️ Firebase send failed: ${pushResult.error}`);
          if (pushResult.error.includes("invalid-registration-token")) {
            await User.findByIdAndUpdate(user._id, { $unset: { fcmToken: 1 } });
          }
        }
      }
    } catch (err) {
      logger.error("❌ Error sending removal notification:", err.message);
    }
  }

  // ✅ Populate latest group info for response
  const populated = await ChatRequest.findById(group._id)
    .populate({ path: 'groupAdmin', select: 'firstname lastname email profileimg' })
    .populate({ path: 'superAdmins', select: 'firstname lastname email profileimg' })
    .populate({ path: 'members', select: 'firstname lastname email profileimg' });

  const creatorIdStr = populated.groupAdmin?._id?.toString();
  const adminIdSet = new Set((populated.superAdmins || []).map(a => a._id.toString()));

  // ✅ Combine members and creator for display (Creator + Members)
  let membersToDisplay = [...(populated.members || [])];
  if (populated.groupAdmin) {
    // Ensure creator is not duplicated
    if (!membersToDisplay.some(m => String(m._id) === creatorIdStr)) {
      membersToDisplay.unshift(populated.groupAdmin); // Add creator to the top
    }
  }

  const filteredMembers = membersToDisplay.filter(m => {
    const mid = m._id.toString();
    // Exclude super admins, but ALLOW creator
    return !adminIdSet.has(mid);
  });

  // ✅ Add userType to each member
  const enhancedMembers = filteredMembers.map(member => {
    const memberIdStr = String(member._id);
    let userType = 'member'; // default

    if (memberIdStr === creatorIdStr) {
      userType = 'creator';
    } else if (adminIdSet.has(memberIdStr)) {
      userType = 'superAdmin';
    }

    return {
      _id: member._id,
      firstname: member.firstname,
      lastname: member.lastname,
      email: member.email,
      profileimg: member.profileimg,
      isDeleted: member.isDeleted || false,
      userType: userType // ✅ ADDED: This identifies the role
    };
  });

  const responseData = populated.toObject();
  responseData.members = enhancedMembers;
  delete responseData.messages;

  // ✅ Clear Redis cache for all group members
  try {
    if (redisClient) {
      const allGroupMemberIds = [
        String(group.groupAdmin),
        ...(group.superAdmins || []).map(String),
        ...(group.members || []).map(String)
      ];

      const cacheKeys = [];
      allGroupMemberIds.forEach(userId => {
        cacheKeys.push(`requests:${String(userId)}:group:*`);
        cacheKeys.push(`requests:${String(userId)}:accepted:*`);
      });

      // Use pattern matching to clear all related cache
      await Promise.all(cacheKeys.map(pattern => deleteRedisKeysByPattern(pattern)));
      logger.log(`✅ Cache cleared for ${allGroupMemberIds.length} group members`);
    }
  } catch (err) {
    logger.warn("⚠️ Redis clear error in group update:", err.message);
  }

  // Build response message
  let responseMessage = "Group updated successfully";
  if (toAdd.length > 0 && toRemove.length > 0) {
    responseMessage = `Group updated: ${toAdd.length} member(s) added, ${toRemove.length} member(s) removed`;
  } else if (toAdd.length > 0) {
    responseMessage = `Group updated: ${toAdd.length} member(s) added`;
  } else if (toRemove.length > 0) {
    responseMessage = `Group updated: ${toRemove.length} member(s) removed`;
  }

  return successResponse(res, responseMessage, responseData, null, 200, 1);
});


export const deleteGroupByCreator = asyncHandler(async (req, res) => {
  const creatorId = req.user?.id;
  const { id } = req.params; // group id

  if (!creatorId) return errorResponse(res, "Unauthorized", 404);

  // Validate MongoDB ObjectId format
  if (!mongoose.Types.ObjectId.isValid(id)) {
    // Invalid ID format - return 200 with status 0 (API worked, but group id not found)
    return successResponse(res, "Group id not found", null, null, 200, 0);
  }

  const group = await ChatRequest.findOne({ _id: id, chatType: 'group', receiverId: null });
  // Group not found - return 200 with status 0 (API worked, but group id not found)
  if (!group) {
    return successResponse(res, "Group id not found", null, null, 200, 0);
  }
  if (String(group.groupAdmin) !== String(creatorId)) {
    return successResponse(res, "Only the creator can delete the group", null, null, 200, 0);
  }

  // ✅ Only delete pending invitations, keep accepted invitations for history
  // This ensures accepted requests remain visible in /api/chat/requests?type=accepted
  await ChatRequest.deleteMany({
    groupId: id,
    status: "pending" // Only delete pending invitations, keep accepted ones
  });

  // Delete the group root
  await ChatRequest.findByIdAndDelete(id);

  // ✅ EMIT SOCKET EVENT FOR GROUP DELETED
  try {
    const io = getIO();
    const allGroupMemberIds = [
      String(group.groupAdmin),
      ...(group.superAdmins || []).map(String),
      ...(group.members || []).map(String)
    ];

    // Notify all group members that the group was deleted
    allGroupMemberIds.forEach(memberId => {
      io.to(`user:${memberId}`).emit("chatList:update", {
        chatId: String(id),
        action: "groupDeleted",
        type: "group"
      });
      io.to(`user:${memberId}`).emit("chatRequests:update");
    });

    logger.log(`📡 Group deleted socket events emitted for group ${id}`);
  } catch (err) {
    logger.error("Socket emit error (group deleted):", err.message);
  }

  // Clear cache for all group members
  // ✅ ENHANCED: Clear cache more aggressively after group updates
  try {
    const allGroupUserIds = [
      group.groupAdmin,
      ...(group.superAdmins || []),
      ...(group.members || [])
    ].map(String).filter(Boolean);

    const cacheKeys = allGroupUserIds.flatMap(uid => [
      `requests:${uid}:group:*`,
      `requests:${uid}:accepted:*`
    ]);

    await Promise.all([
      ...cacheKeys.map(pattern => deleteRedisKeysByPattern(pattern)),
      redisClient.del(allGroupUserIds.flatMap(uid => [
        `requests:${uid}:group`,
        `requests:${uid}:accepted`
      ]))
    ]);
  } catch (err) {
    logger.warn("⚠️ Redis clear error:", err.message);
  }

  return successResponse(res, "Group deleted", null, null, 200, 1);
});

// Update group profile (name and/or image) - any group member can update
export const updateGroupProfileByCreator = asyncHandler(async (req, res) => {
  const userId = req.user?.id;
  const { groupId, name, image } = req.body;

  if (!userId) return errorResponse(res, "Unauthorized", 404);
  if (!groupId) return errorResponse(res, "groupId is required", 404);

  if (!mongoose.Types.ObjectId.isValid(groupId)) {
    return successResponse(res, "Group id not found", null, null, 200, 0);
  }

  const group = await ChatRequest.findOne({ _id: groupId, chatType: 'group', receiverId: null });
  if (!group) {
    return successResponse(res, "Group id not found", null, null, 200, 0);
  }

  // ✅ Check if user has isAdmin: true - admins can only view, not update
  if (req.user?.isAdmin === true) {
    return successResponse(res, "Admins can only view the group profile, not update it", null, null, 200, 0);
  }

  // ✅ Check if user is a group member (creator, superAdmin, or regular member)
  const isCreator = String(group.groupAdmin) === String(userId);
  const isSuperAdmin = (group.superAdmins || []).map(String).includes(String(userId));
  const isMember = (group.members || []).map(String).includes(String(userId));

  if (!isCreator && !isSuperAdmin && !isMember) {
    return successResponse(res, "You are not a member of this group", null, null, 200, 0);
  }

  // Track what changed for notifications
  const changes = {};

  // Update fields
  const trimmedName = typeof name === 'string' ? name.trim() : '';
  if (trimmedName && trimmedName !== group.name) {
    group.name = trimmedName;
    changes.name = trimmedName;
  }

  // ✅ Handle image from file upload (multipart/form-data)
  const file = req.file;
  if (file) {
    const newImagePath = `/uploads/${file.filename}`;
    if (newImagePath !== group.groupImage) {
      group.groupImage = newImagePath;
      changes.image = newImagePath;
    }
  }
  // ✅ Handle image URL from JSON body (application/json)
  else if (image && typeof image === 'string' && image.trim()) {
    const imageUrl = image.trim();
    if (imageUrl !== group.groupImage) {
      group.groupImage = imageUrl;
      changes.image = imageUrl;
    }
  }

  // Only save and notify if there are changes
  if (Object.keys(changes).length > 0) {
    await group.save();

    // Get all group member IDs for notifications
    const allGroupMemberIds = [
      group.groupAdmin,
      ...(group.superAdmins || []),
      ...(group.members || [])
    ].map(String).filter(Boolean);

    // Emit socket event to notify all group members about profile update
    try {
      const io = getIO();
      const updateData = {
        groupId: String(group._id),
        ...changes,
        updatedAt: group.updatedAt
      };

      // Emit to all group members via their chat room
      io.to(`chat:${String(group._id)}`).emit("groupProfileUpdated", updateData);

      // Also emit individually to ensure all members are notified
      allGroupMemberIds.forEach(memberId => {
        io.to(`user:${memberId}`).emit("groupProfileUpdated", updateData);
      });
    } catch (error) {
      logger.error("Socket emit error for group profile update:", error.message);
    }

    // Clear cache for all group members
    try {
      const cacheKeys = allGroupMemberIds.flatMap(uid => [
        `requests:${uid}:group`,
        `chat:${String(group._id)}`
      ]);
      await redisClient.del(cacheKeys);
    } catch (err) {
      logger.warn("⚠️ Redis delete failed:", err.message);
    }
  }

  const populated = await ChatRequest.findById(group._id)
    .populate({ path: 'groupAdmin', select: 'firstname lastname email' })
    .populate({ path: 'superAdmins', select: 'firstname lastname email' })
    .populate({ path: 'members', select: 'firstname lastname email' });

  const responseData = populated.toObject();
  delete responseData.messages;

  return successResponse(res, "Group profile updated", responseData, null, 200, 1);
});