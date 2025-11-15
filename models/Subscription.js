import mongoose from "mongoose";

const subscriptionSchema = new mongoose.Schema(
  {
    // 🔗 Reference to User
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    // 🧾 Stripe identifiers
    stripeCustomerId: {
      type: String,
      required: true,
      index: true,
    },
    stripeSubscriptionId: {
      type: String,
      required: true,
      unique: true,
    },
    priceId: {
      type: String,
      required: true,
    },

    // 💰 Payment details
    amount: {
      type: Number,
      required: true,
    },
    currency: {
      type: String,
      required: true,
      uppercase: true,
      default: "USD",
    },

    // 📅 Plan details
    planType: {
      type: String,
      enum: ["monthly", "yearly", "testing"],
      required: true,
    },
    status: {
      type: String,
      enum: ["active", "trialing", "canceled", "expired"],
      default: "active",
    },
    startDate: {
      type: Date,
      required: true,
    },
    endDate: {
      type: Date,
      required: true,
    },
    canceledAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

//
// 🔄 Auto-sync user subscription info after save
//
subscriptionSchema.post("save", async function (doc) {
  try {
    const User = mongoose.model("User");

    if (doc.status === "active" || doc.status === "trialing") {
      await User.findByIdAndUpdate(doc.userId, {
        isSubscription: true,
        subscriptionType: doc.planType,
        subscriptionStartDate: doc.startDate,
        subscriptionEndDate: doc.endDate,
        lastSubscriptionDate: new Date(),
      });
    } else {
      await User.findByIdAndUpdate(doc.userId, {
        isSubscription: false,
      });
    }
  } catch (error) {
    console.error("❌ Error syncing user subscription:", error);
  }
});

const Subscription =
  mongoose.models.Subscription ||
  mongoose.model("Subscription", subscriptionSchema);

export default Subscription;
