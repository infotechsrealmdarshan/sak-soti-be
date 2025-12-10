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
  // Check both individual chats AND previously accepted group invitations
  // Convert all IDs to ensure proper MongoDB query matching
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

  // Check for previously accepted group invitations (even if group was deleted)
  // If user accepted a group invitation before, add them directly to new groups
  const acceptedGroupInvitations = await ChatRequest.find({
    chatType: "group",
    status: "accepted",
    senderId: creatorIdForQuery,
    receiverId: { $in: filteredInputIdsForQuery },
  }).select("senderId receiverId");

  // Also check if user was ever a member of any group created by this creator
  // This helps even if invitation records were deleted when group was deleted
  const previousGroupMemberships = await ChatRequest.find({
    chatType: "group",
    receiverId: null, // Group root documents
    senderId: creatorIdForQuery,
    $or: [
      { members: { $in: filteredInputIdsForQuery } },
      { superAdmins: { $in: filteredInputIdsForQuery } }
    ]
  }).select("members superAdmins");

  // Extract user IDs from previous group memberships
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

  // Add users who were in previous groups to accepted list
  const previousGroupMemberIdsArray = Array.from(previousGroupMemberIds);
  if (previousGroupMemberIdsArray.length > 0) {
    console.log("Users found in previous groups (adding directly):", previousGroupMemberIdsArray);
  }

  // Combine both types of accepted chats
  const acceptedChats = [...acceptedIndividualChats, ...acceptedGroupInvitations];

  // ✅ Determine who has accepted chats (convert all to strings for consistent comparison)
  const acceptedMemberIdsFromChats = acceptedChats.map((chat) => {
    const senderIdStr = String(chat.senderId);
    const receiverIdStr = String(chat.receiverId);
    const creatorIdStrForCompare = String(creatorId);

    // Return the other user's ID (not the creator)
    return senderIdStr === creatorIdStrForCompare ? receiverIdStr : senderIdStr;
  });

  // Combine accepted chats with previous group members
  const acceptedMemberIds = Array.from(new Set([
    ...acceptedMemberIdsFromChats,
    ...previousGroupMemberIdsArray
  ]));

  // ✅ Log for debugging (remove in production if needed)
  if (acceptedMemberIds.length > 0) {
    console.log(`Found ${acceptedMemberIds.length} users with accepted chats:`, acceptedMemberIds);
  }

  // ✅ Convert to Set for faster lookup and ensure all are strings
  const acceptedMemberIdsSet = new Set(acceptedMemberIds.map(id => String(id)));

  // ✅ Split members vs invitations (before checking admins)
  // Users with accepted individual chats are added directly, no invitation needed
  const initialConfirmedMembers = Array.from(new Set([
    String(creatorId),
    ...Array.from(acceptedMemberIdsSet)
  ]));

  // ✅ Only users without accepted chats go to invitation list
  const initialInvitationIds = filteredInputIds.filter(
    (id) => {
      const idStr = String(id);
      return !acceptedMemberIdsSet.has(idStr) && idStr !== creatorIdStr;
    }
  );

  // ✅ Fetch creator data to check isAdmin status
  const creator = await User.findById(creatorId).select("firstname lastname isAdmin");
  if (!creator) {
    return errorResponse(res, "Creator user not found", 404);
  }

  // ✅ Check if any users in invitationIds have isAdmin: true
  // Super admins (isAdmin: true) should be added directly, not sent invitations
  // Convert initialInvitationIds to ObjectIds for proper MongoDB query
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

  // Debug: Log admins found from invitations
  if (adminIdsFromInvitations.length > 0) {
    console.log("Admins found from invitations and added directly:", adminIdsFromInvitations);
  }

  // ✅ Add admins directly to confirmed members (no invitation needed)
  let confirmedMembers = Array.from(new Set([...initialConfirmedMembers, ...adminIdsFromInvitations]));

  // ✅ Remove admins from invitation list (they are added directly)
  const invitationIds = initialInvitationIds.filter(
    (id) => !adminIdsFromInvitations.includes(String(id))
  );

  // ✅ Find ALL super admins from database (not just from memberIds)
  // OLD CODE (single admin): const superAdminUser = await User.findOne({ isAdmin: true })
  // NEW CODE: Get ALL users with isAdmin: true and add them all
  const allSuperAdminUsers = await User.find({ isAdmin: true })
    .select("_id isAdmin")
    .sort({ createdAt: 1 }); // Sort by creation date for consistency

  // ✅ If super admins found, add them all to confirmed members and superAdmins
  let superAdminsList = [];
  if (allSuperAdminUsers && allSuperAdminUsers.length > 0) {
    // Add all super admins to confirmed members if not already there
    allSuperAdminUsers.forEach(superAdminUser => {
      const superAdminId = String(superAdminUser._id);
      if (!confirmedMembers.includes(superAdminId)) {
        confirmedMembers.push(superAdminId);
      }
    });
    confirmedMembers = Array.from(new Set(confirmedMembers)); // Remove duplicates

    // Add all super admins to superAdmins list (multiple admins support)
    superAdminsList = allSuperAdminUsers.map(admin => admin._id);

    console.log(`Found ${allSuperAdminUsers.length} super admin(s) and added:`, superAdminsList.map(id => String(id)));
  } else {
    console.log("No super admin found in database");
  }

  // ✅ Generate default group name if not provided
  let groupName = String(name || "").trim();
  if (!groupName) {
    const displayNames = [creator, ...users]
      .filter(Boolean)
      .map((u) => `${u.firstname || ""} ${u.lastname || ""}`.trim())
      .filter(Boolean);
    groupName = displayNames.join(", ");
  }

  // ✅ Create group root document in ChatRequest
  const group = await ChatRequest.create({
    senderId: creatorId,
    receiverId: null,
    chatType: "group",
    status: "accepted",
    groupId: undefined, // will set to self
    name: groupName,
    groupAdmin: creatorId,
    superAdmins: superAdminsList,
    members: confirmedMembers,
    pendingMembers: [],
    groupImage: groupImage,
  });

  // ✅ Set groupId to self
  if (!group.groupId) {
    group.groupId = group._id;
    await group.save();
  }

  // ✅ Create ChatRequest invitations for users without accepted chats
  // Explicitly exclude creator from invitations (double-check filter)
  const finalInvitationIds = invitationIds.filter(
    (id) => String(id) !== creatorIdStr
  );

  const invitationRequests = [];
  for (const inviteeId of finalInvitationIds) {
    // Double check: ensure creator is not in the list
    if (String(inviteeId) === creatorIdStr) continue;

    // Check if invitation already exists
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
    const groupName = group.name || "New Group";

    // 🔹 For directly added members
    const directAddedMembers = confirmedMembers.filter(id => String(id) !== String(creatorId));
    for (const memberId of directAddedMembers) {
      const member = await User.findById(memberId).select("fcmToken email");
      if (!member) continue;

      const body = `${creatorName} added you to group “${groupName}”.`;
      const notification = await Notification.create({
        userId: member._id,
        title: titleAdded,
        message: body,
        deeplink: "",
      });

      console.log("Member info for group added notification>>>>>>>>>>>:", notification);

      if (member.fcmToken) {
        const pushResult = await sendFirebaseNotification(
          member.fcmToken,
          titleAdded,
          body,
          { type: "group_added", groupId: group._id.toString(), senderId: creatorId }
        );
        notification.firebaseStatus = pushResult.success ? "sent" : "failed";
        await notification.save();
      }

      io.to(`user:${memberId}`).emit("group:added", { groupId: group._id, groupName });
    }

    // 🔹 For invited members
    for (const invite of invitationRequests) {
      const invitee = await User.findById(invite.receiverId).select("fcmToken email");
      if (!invitee) continue;

      const body = `${creatorName} invited you to join group “${groupName}”.`;
      const notification = await Notification.create({
        userId: invitee._id,
        title: titleInvited,
        message: body,
        deeplink: "",
      });

      console.log("Invitee info for group invitation notification>>>>>>>>>>>:", notification);

      if (invitee.fcmToken) {
        const pushResult = await sendFirebaseNotification(
          invitee.fcmToken,
          titleInvited,
          body,
          { type: "group_invitation", groupId: group._id.toString(), senderId: creatorId }
        );
        notification.firebaseStatus = pushResult.success ? "sent" : "failed";
        await notification.save();
      }

      io.to(`user:${invite.receiverId}`).emit("group:invited", { groupId: group._id, groupName });
    }
  } catch (err) {
    console.error("❌ Error sending group create notifications:", err.message);
  }


  // ✅ Populate group data
  const populated = await ChatRequest.findById(group._id)
    .populate({ path: "groupAdmin", select: "firstname lastname email isAdmin" })
    .populate({ path: "superAdmins", select: "firstname lastname email isAdmin" })
    .populate({ path: "members", select: "firstname lastname email" });

  // ✅ Record join time for initial members in conversation doc
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
    console.warn("⚠️ Failed to record initial group join times:", err.message);
  }

  const populatedCreatorIdStr = populated.groupAdmin?._id?.toString();
  const adminIdSet = new Set(
    (populated.superAdmins || []).map((a) => a._id.toString())
  );

  // ✅ Filter members excluding creator/admins from member list (for display only)
  const filteredMembers = (populated.members || []).filter((m) => {
    const id = m._id.toString();
    return id !== populatedCreatorIdStr && !adminIdSet.has(id);
  });

  const responseData = populated.toObject();
  responseData.members = filteredMembers;

  // ✅ Compute all unique user IDs (super admin, admin, and members) for total count
  const allUniqueUserIds = new Set();
  if (populated.groupAdmin?._id) {
    allUniqueUserIds.add(populated.groupAdmin._id.toString());
  }
  (populated.superAdmins || []).forEach((a) => {
    if (a._id) allUniqueUserIds.add(a._id.toString());
  });
  (populated.members || []).forEach((m) => {
    if (m._id) allUniqueUserIds.add(m._id.toString());
  });

  // ✅ Compute accurate unique admin counts
  const uniqueAdminIds = new Set(
    [
      populated.groupAdmin?._id?.toString(),
      ...(populated.superAdmins || []).map((a) => a._id.toString()),
    ].filter(Boolean)
  );

  // ✅ Build final response - ensure creator is not in invitations list (triple-check filter)
  const finalInvitationsList = finalInvitationIds.filter(
    (id) => String(id) !== creatorIdStr
  );

  const responseWithExtras = {
    ...responseData,
    counts: {
      creatorCount: populated.groupAdmin ? 1 : 0,
      adminsCount: uniqueAdminIds.size,
      membersCount: allUniqueUserIds.size, // Total count of all unique users (super admin, admin, and members)
    },
    invitations: finalInvitationsList, // List of user IDs who received invitations (creator excluded)
  };

  // ✅ Clear Redis cache for creator and invitees
  try {
    if (redisClient) {
      const cacheKeys = [`requests:${String(creatorId)}:group`];
      // Also clear cache for invitees (excluding creator)
      finalInvitationsList.forEach((inviteeId) => {
        if (String(inviteeId) !== creatorIdStr) {
          cacheKeys.push(`requests:${String(inviteeId)}:group`);
          cacheKeys.push(`requests:${String(inviteeId)}:received`);
        }
      });
      await redisClient.del(cacheKeys);
    }
  } catch (err) {
    console.warn("⚠️ Redis delete failed:", err.message);
  }

  // ✅ EMIT SOCKET EVENT FOR GROUP CREATED
  try {
    const io = getIO();
    const allGroupMemberIds = [
      String(creatorId),
      ...confirmedMembers.filter(id => String(id) !== String(creatorId))
    ];

    // Notify all group members about the new group
    allGroupMemberIds.forEach(memberId => {
      io.to(`user:${memberId}`).emit("chatList:update", {
        chatId: String(group._id),
        action: "groupCreated",
        type: "group",
        groupData: responseWithExtras
      });
      io.to(`user:${memberId}`).emit("chatRequests:update");
    });

    console.log(`📡 Group created socket events emitted for group ${group._id}`);
  } catch (err) {
    console.error("Socket emit error (group created):", err.message);
  }

  // ✅ Final response
  return successResponse(res, "Group created", responseWithExtras, null, 200, 1);
});

export const updateGroupByCreator = asyncHandler(async (req, res) => {
  const creatorId = req.user?.id;
  const { groupId, type, memberIds = [] } = req.body; // type: 'add' | 'remove'

  if (!creatorId) return errorResponse(res, "Unauthorized", 404);
  if (!groupId) return errorResponse(res, "groupId is required", 404);
  if (!type || !["add", "remove"].includes(type)) {
    return errorResponse(res, "type must be 'add' or 'remove'", 404);
  }
  if (!Array.isArray(memberIds) || memberIds.length === 0) {
    return errorResponse(res, "memberIds must be a non-empty array", 404);
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

  const targetIds = Array.from(new Set(memberIds.map(String))).filter(uid => uid !== String(creatorId));
  if (type === "add" && targetIds.includes(String(creatorId))) {
    return successResponse(res, "You cannot add your own user", null, null, 200, 0);
  }

  // ✅ Add Members
  if (type === "add") {
    const users = await User.find({ _id: { $in: targetIds } }).select("_id firstname lastname email fcmToken isSubscription isAdmin");
    if (users.length !== targetIds.length) {
      return successResponse(res, "One or more user ids not found", null, null, 200, 0);
    }

    const allSubscribed = users.every(u => !!u.isSubscription || !!u.isAdmin);
    if (!allSubscribed) {
      return successResponse(res, "All members must have an active subscription.", null, null, 200, 0);
    }

    const current = new Set((group.members || []).map(id => id.toString()));
    const alreadyAdded = targetIds.filter(uid => current.has(uid));
    if (alreadyAdded.length > 0) {
      return successResponse(res, "Some users are already members", null, null, 200, 0);
    }

    // Add new members
    for (const uid of targetIds) current.add(uid);
    group.members = Array.from(current);
    await group.save();

    // ✅ Record join time for new members
    try {
      const joinedAtDate = new Date();
      const joinedAtUpdate = {};
      targetIds.forEach(id => {
        joinedAtUpdate[`joinedAtByUser.${String(id)}`] = joinedAtDate;
      });
      const participantSet = new Set(Array.from(current).map(String));
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
      console.warn("⚠️ Failed to record join time for added members:", err.message);
    }

    // ✅ EMIT SOCKET EVENT FOR GROUP MEMBER ADDED
    try {
      const io = getIO();
      const allGroupMemberIds = [
        String(group.groupAdmin),
        ...(group.superAdmins || []).map(String),
        ...Array.from(current)
      ];

      // Notify all group members about the update
      allGroupMemberIds.forEach(memberId => {
        io.to(`user:${memberId}`).emit("chatList:update", {
          chatId: String(group._id),
          action: "membersAdded",
          type: "group",
          addedMemberIds: targetIds
        });
        io.to(`user:${memberId}`).emit("chatRequests:update");
      });

      console.log(`📡 Group member added socket events emitted for group ${group._id}`);
    } catch (err) {
      console.error("Socket emit error (group member added):", err.message);
    }

    // 🔔 Send notifications to newly added users
    for (const user of users) {
      try {
        const title = "Added to Group";
        const message = `${creatorName} added you to the group “${group.name || "Group"}”.`;

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
            { type: "group_add", groupId: group._id.toString(), senderId: creatorId }
          );

          console.log(`💾 Notification saved to DB for added user ${user._id}: ${notification}`);

          notification.firebaseStatus = pushResult.success ? "sent" : "failed";
          await notification.save();

          if (pushResult.success) {
            console.log(`✅ Added-to-group notification sent to ${user.email}`);
          } else {
            console.error(`⚠️ Firebase send failed: ${pushResult.error}`);
            if (pushResult.error.includes("invalid-registration-token")) {
              await User.findByIdAndUpdate(user._id, { $unset: { fcmToken: 1 } });
            }
          }
        } else {
          console.warn(`⚠️ No FCM token for ${user.email}, skipping push notification`);
        }
      } catch (err) {
        console.error("❌ Error sending add notification:", err.message);
      }
    }
  }

  // ✅ Remove Members
  if (type === "remove") {
    const removeSet = new Set(targetIds);
    const removedUsers = await User.find({ _id: { $in: Array.from(removeSet) } })
      .select("_id firstname lastname email fcmToken");

    group.members = (group.members || [])
      .filter(m => !removeSet.has(m.toString()))
      .filter(m => m.toString() !== String(creatorId));

    group.superAdmins = (group.superAdmins || [])
      .filter(a => a.toString() !== String(creatorId));

    await group.save();

    // ✅ EMIT SOCKET EVENT FOR GROUP MEMBER REMOVED
    try {
      const io = getIO();
      const allGroupMemberIds = [
        String(group.groupAdmin),
        ...(group.superAdmins || []).map(String),
        ...(group.members || []).map(String)
      ];

      // Notify remaining group members about the update
      allGroupMemberIds.forEach(memberId => {
        io.to(`user:${memberId}`).emit("chatList:update", {
          chatId: String(group._id),
          action: "membersRemoved",
          type: "group",
          removedMemberIds: targetIds
        });
        io.to(`user:${memberId}`).emit("chatRequests:update");
      });

      // Notify removed members
      targetIds.forEach(removedId => {
        io.to(`user:${removedId}`).emit("chatList:update", {
          chatId: String(group._id),
          action: "removedFromGroup",
          type: "group"
        });
        io.to(`user:${removedId}`).emit("chatRequests:update");
      });

      console.log(`📡 Group member removed socket events emitted for group ${group._id}`);
    } catch (err) {
      console.error("Socket emit error (group member removed):", err.message);
    }

    // 🔔 Notify removed users
    for (const user of removedUsers) {
      try {
        const title = "Removed from Group";
        const message = `You have been removed from the group “${group.name || "Group"}” by ${creatorName}.`;

        const notification = await Notification.create({
          userId: user._id,
          title,
          message,
          deeplink: "",
        });

        console.log(`💾 Notification saved to DB for removed user ${user._id}: ${notification}`);

        if (user.fcmToken) {
          const pushResult = await sendFirebaseNotification(
            user.fcmToken,
            title,
            message,
            { type: "group_remove", groupId: group._id.toString(), senderId: creatorId }
          );

          notification.firebaseStatus = pushResult.success ? "sent" : "failed";
          await notification.save();

          if (pushResult.success) {
            console.log(`✅ Removal notification sent to ${user.email}`);
          } else {
            console.error(`⚠️ Firebase send failed: ${pushResult.error}`);
            if (pushResult.error.includes("invalid-registration-token")) {
              await User.findByIdAndUpdate(user._id, { $unset: { fcmToken: 1 } });
            }
          }
        } else {
          console.warn(`⚠️ No FCM token for ${user.email}, skipping push notification`);
        }
      } catch (err) {
        console.error("❌ Error sending removal notification:", err.message);
      }
    }
  }

  // ✅ Populate latest group info for response
  const populated = await ChatRequest.findById(group._id)
    .populate({ path: 'groupAdmin', select: 'firstname lastname email profileimg' })
    .populate({ path: 'superAdmins', select: 'firstname lastname email profileimg' })
    .populate({ path: 'members', select: 'firstname lastname email profileimg' });

  const creatorIdStr = populated.groupAdmin?._id?.toString();
  const adminIdSet = new Set((populated.superAdmins || []).map(a => a._id.toString()));
  const filteredMembers = (populated.members || []).filter(m => {
    const mid = m._id.toString();
    return mid !== creatorIdStr && !adminIdSet.has(mid);
  });

  const responseData = populated.toObject();
  responseData.members = filteredMembers;
  delete responseData.messages;

  return successResponse(res, `Group ${type === "add" ? "updated (members added)" : "updated (members removed)"}`, responseData, null, 200, 1);
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

    console.log(`📡 Group deleted socket events emitted for group ${id}`);
  } catch (err) {
    console.error("Socket emit error (group deleted):", err.message);
  }

  // Clear cache for all group members
  try {
    const allGroupUserIds = [
      group.groupAdmin,
      ...(group.superAdmins || []),
      ...(group.members || [])
    ].map(String).filter(Boolean);
    const cacheKeys = allGroupUserIds.flatMap(uid => [
      `requests:${uid}:group`,
      `requests:${uid}:accepted`
    ]);
    await redisClient.del(cacheKeys);
  } catch { }

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
      console.error("Socket emit error for group profile update:", error.message);
    }

    // Clear cache for all group members
    try {
      const cacheKeys = allGroupMemberIds.flatMap(uid => [
        `requests:${uid}:group`,
        `chat:${String(group._id)}`
      ]);
      await redisClient.del(cacheKeys);
    } catch (err) {
      console.warn("⚠️ Redis delete failed:", err.message);
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