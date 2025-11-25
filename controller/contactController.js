import Contact from "../models/Contact.js";
import { successResponse } from "../utils/response.js";
import { asyncHandler } from "../utils/errorHandler.js";

/**
 * 1️⃣ POST /api/contact — User creates a contact message
 */
export const createContact = asyncHandler(async (req, res) => {
    const { fullName, email, phoneNumber, message } = req.body;
    const { isAdmin } = req.user;

    // ❌ Block admin users
    if (isAdmin) {
        return successResponse(
            res,
            "Admins are not allowed to submit contact forms.",
            null,
            null,
            403
        );
    }

    // ✅ Validate required fields
    if (!fullName || !email || !phoneNumber || !message)
        return successResponse(res, "All fields are required", null, null, 200, 0);

    // ✅ Validate phone number format
    const phoneRegex = /^\+\d{10,15}$/;
    if (!phoneRegex.test(phoneNumber))
        return successResponse(
            res,
            "Invalid phone number format. Example: +189784563210",
            null,
            null,
            200,
            0
        );

    const contact = await Contact.create({
        fullName,
        email,
        phoneNumber,
        message,
        userId: req.user?.id,
    });

    // Remove unnecessary properties before sending
    const contactResponse = contact.toObject();
    delete contactResponse.__v;

    return successResponse(res, "Message submitted successfully", contactResponse, null, 200, 1);
});

/**
 * 2️⃣ GET /api/contact/me — User’s own messages by email
 */
export const getMyContacts = asyncHandler(async (req, res) => {
  const userEmail = req.user?.email;

  // 🧱 Block if user is admin
  if (req.user.isAdmin) {
    return successResponse(
      res,
      "Admins cannot fetch user contact requests.",
      null,
      null,
      403
    );
  }

  // 🚫 No email in token (should never happen, but safe check)
  if (!userEmail) {
    return successResponse(res, "Unauthorized: user email missing", null, null, 401, 0);
  }

  // ✅ Find all messages by the logged-in user
  const contacts = await Contact.find({ userId: req.user.id }).sort({ createdAt: -1 });

  if (!contacts.length)
    return successResponse(res, "No contact messages found for your account.", [], null, 200, 1);

  return successResponse(res, "Your contact requests retrieved successfully", contacts, null, 200, 1);
});


/**
 * 3️⃣ GET /api/contact/all — Admin: View all with filters, search, sort, pagination
 */
export const getAllContacts = asyncHandler(async (req, res) => {
  // 🧱 Allow only admins
  if (!req.user?.isAdmin) {
    return successResponse(
      res,
      "Access denied: only admins can view all contact requests.",
      null,
      null,
      403
    );
  }

  let {
    page = 1,
    limit = 10,
    search = "",
    orderBy = "createdAt",
    order = "desc",
  } = req.query;

  page = Number(page);
  limit = Number(limit);

  const query = {};

  // 🔍 Search by name or email
  if (search) {
    query.$or = [
      { fullName: { $regex: search, $options: "i" } },
      { email: { $regex: search, $options: "i" } },
    ];
  }

  // 📊 Sorting logic
  const sortDirection = order === "asc" ? 1 : -1;
  const sortOptions = { [orderBy]: sortDirection };

  // 📄 Pagination + Fetch
  const total = await Contact.countDocuments(query);
  const contacts = await Contact.find(query)
    .sort(sortOptions)
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();

  const cleanContacts = contacts.map(({ __v, ...data }) => data);

  // Calculate pagination (same as news API)
  const totalPages = Math.ceil(total / limit);

  // Return response with same structure as news API
  res.json({
    success: true,
    message: "All contact requests retrieved successfully.",
    data: cleanContacts,
    pagination: {
      currentPage: page,
      totalPages,
      totalContacts: total,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    },
  });
});

/**
 * 4️⃣ GET /api/contact/:id — Admin: Get single contact details
 */
export const getContactById = asyncHandler(async (req, res) => {
  const { id } = req.params;

  // 🧱 Allow only admins
  if (!req.user?.isAdmin) {
    return successResponse(
      res,
      "Access denied: only admins can view contact details.",
      null,
      null,
      403
    );
  }

  // 🔍 Validate ID format
  if (!id || id.length !== 24) {
    return successResponse(res, "Invalid contact ID format.", null, null, 400, 0);
  }

  // 🔎 Fetch contact
  const contact = await Contact.findById(id).lean(); // .lean() gives a plain JS object

  if (!contact) {
    return successResponse(res, "Contact not found.", null, null, 404, 0);
  }

  // 🧹 Clean up output
  delete contact.__v;

  return successResponse(
    res,
    "Contact details fetched successfully.",
    contact,
    null,
    200,
    1
  );
});
