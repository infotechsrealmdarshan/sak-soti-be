import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const userSchema = new mongoose.Schema(
  {
    firstname: { type: String, required: true, trim: true },
    lastname: { type: String, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true },
    password: {
      type: String,
      required: function () {
        return !(this.isNew && !this.password);
      },
      minlength: 8,
      select: false,
      validate: {
        validator: function (value) {
          if (this.isNew && !value) return true;
          if (value) {
            return /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[\W_]).{8,}$/.test(value);
          }
          return true;
        },
        message:
          "Password must be at least 8 characters long and include one uppercase letter, one lowercase letter, one number, and one special character.",
      },
    },
    profileimg: { type: String, default: "/uploads/default.png" },
    status: { type: String, enum: ["active", "inactive"], default: "active" },
    isAdmin: { type: Boolean, default: false },
    isSubscription: { type: Boolean, default: false },
    subscriptionType: {
      type: String,
      enum: ["monthly", "yearly", "testing"],
      default: null,
    },
    subscriptionStartDate: {
      type: Date,
      default: null,
    },
    subscriptionEndDate: {
      type: Date,
      default: null,
    },
    lastSubscriptionDate: {
      type: Date,
      default: null,
    },
    firebaseToken: {
      type: String,
      default: null,
      select: false,
    },
    stripeCustomerId: {
      type: String,
      default: null,
    },
    fcmToken: {
      type: String,
      default: null,
    },
    country: {
      type: String,
      default: null,
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },
    deletedAt: {
      type: Date,
      default: null,
    },

  },
  { timestamps: true }
);

userSchema.pre("save", async function (next) {
  if (!this.isModified("password") || !this.password) return next();
  const salt = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// ✅ Handle deleted users: Remove from groups when isDeleted becomes true
userSchema.post("save", async function (doc) {
  // Only process if isDeleted was modified and is now true
  if (this.isModified("isDeleted") && doc.isDeleted === true) {
    try {
      // Dynamically import to avoid circular dependency
      const { removeDeletedUserFromGroups } = await import("../utils/chatHelper.js");
      await removeDeletedUserFromGroups(doc._id.toString());
      console.log(`✅ Removed deleted user ${doc._id} from all groups`);
    } catch (error) {
      console.error(`❌ Error removing deleted user from groups:`, error);
    }
  }

  // Handle user restoration (isDeleted becomes false)
  if (this.isModified("isDeleted") && doc.isDeleted === false) {
    try {
      const { handleUserRestored } = await import("../utils/chatHelper.js");
      await handleUserRestored(doc._id.toString());
      console.log(`✅ User ${doc._id} restored - chat lists updated`);
    } catch (error) {
      console.error(`❌ Error handling user restore:`, error);
    }
  }
});

userSchema.methods.comparePassword = async function (enteredPassword) {
  return bcrypt.compare(enteredPassword, this.password);
};

const User = mongoose.models.User || mongoose.model("User", userSchema);
export default User;
