import mongoose from "mongoose";

const subscriptionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    stripeCustomerId: { type: String, required: true },
    stripeSubscriptionId: { type: String, required: true, unique: true },
    priceId: { type: String, required: true },

    amount: { type: Number, required: true },
    currency: { type: String, required: true, uppercase: true, default: "USD" },

    planType: {
      type: String,
      enum: ["monthly", "yearly", "testing"],
      required: true,
    },

    status: {
      type: String,
      enum: [
        "in_progress",
        "active",
        "trialing",
        "canceled",
        "expired",
        "incomplete",
        "past_due",
        "unpaid",
      ],
      default: "in_progress",
    },

    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    canceledAt: { type: Date, default: null },
  },
  { timestamps: true }
);

const Subscription =
  mongoose.models.Subscription ||
  mongoose.model("Subscription", subscriptionSchema);

export default Subscription;
