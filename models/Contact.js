import mongoose from "mongoose";

const contactSchema = new mongoose.Schema(
  {
    fullName: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    phoneNumber: {
      type: String,
      required: true,
      validate: {
        validator: (v) => /^\+\d{10,15}$/.test(v),
        message: (props) => `${props.value} is not a valid phone number!`,
      },
    },
    message: { type: String, required: true, trim: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

export default mongoose.model("Contact", contactSchema);
