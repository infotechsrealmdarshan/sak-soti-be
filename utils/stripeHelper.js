// utils/stripeHelper.js
import Stripe from "stripe";
import User from "../models/User.js";

// Initialize Stripe - using default API version (latest stable)
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ✅ Create a new Stripe customer and store in DB
export const createStripeCustomer = async (user) => {
  try {
    const customer = await stripe.customers.create({
      email: user.email,
      name: `${user.firstname} ${user.lastname}`,
      metadata: { userId: user._id.toString() },
    });

    user.stripeCustomerId = customer.id;
    await user.save();

    console.log(`✅ Stripe customer created for user ${user.email}: ${customer.id}`);
    return customer.id;
  } catch (err) {
    console.error("❌ Stripe customer creation failed:", err.message);
    throw err;
  }
};

export const validateStripeCustomer = async (stripeCustomerId) => {
  if (!stripeCustomerId) return false;

  try {
    const customer = await stripe.customers.retrieve(stripeCustomerId);
    if (customer?.deleted) return false; // deleted customer
    return true;
  } catch (err) {
    console.warn("⚠️ Stripe customer validation failed:", err.message);
    return false;
  }
};
