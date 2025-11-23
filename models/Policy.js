import mongoose from "mongoose";

const policySchema = new mongoose.Schema(
    {
        policyType: {
            type: String,
            enum: ["privacy", "terms"],
            required: true,
        },
        contentHtml: {
            type: String, // Raw HTML from CKEditor
            required: true,
        },
        contentText: {
            type: String, // Plain text (stripped HTML)
            required: true,
        },
    },
    { timestamps: true }
);

export default mongoose.model("Policy", policySchema);
