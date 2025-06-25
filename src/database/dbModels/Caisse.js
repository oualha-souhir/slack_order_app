const mongoose = require("mongoose");

mongoose.set("strictQuery", false);
const fundingRequestSchema = new mongoose.Schema({
  requestId: { type: String, required: true },
  changed:{ type: Boolean, default: false },
  amount: { type: Number, required: true },
  currency: { type: String, required: true},
  reason: { type: String, required: true },
  requestedDate: { type: String },
  submittedBy: { type: String, required: true },
  submittedByID: { type: String },

  submitterName: { type: String },
  status: { 
    type: String, 
    required: true, 
    default: "En attente" 
  },
  rejectionReason: { type: String },
  submittedAt: { type: Date, default: Date.now },
  approvedBy: { type: String },
  approvedAt: { type: Date },
  disbursementType: { type: String },
  paymentDetails: {
    method: { type: String },
    notes: { type: String },
    approvedBy: { type: String },
    approvedAt: { type: Date },
    filledBy: { type: String },
    filledByName: { type: String },

    filledAt: { type: Date },
    cheque: {
      type: {
        number: String,
        bank: String,
        date: String,
        order: String,
        file_ids: [String], // Store multiple file IDs
        urls: [String], // Array for page URLs
      },
      default: null,
      
    }
  },
  workflow: {
    stage: { type: String, required: true, default: "initial_request" },
    history: [{
      stage: { type: String, required: true },
      timestamp: { type: Date, default: Date.now },
      actor: { type: String, required: true },
      details: { type: String }
    }]
  }
});
const transactionSchema = new mongoose.Schema({
  type: { type: String, required: true },
  amount: { type: Number, required: true },
  currency: { type: String, required: true },
  requestId: { type: String },
  orderId: { type: String },
  details: { type: String },
  timestamp: { type: Date, default: Date.now },
  paymentMethod: { type: String },
  paymentDetails: { type: mongoose.Schema.Types.Mixed }
});

const caisseSchema = new mongoose.Schema({
  balances: {
    XOF: { type: Number, default: 0 },
    USD: { type: Number, default: 0 },
    EUR: { type: Number, default: 0 }
  },
  latestRequestId: { type: String },
  fundingRequests: [fundingRequestSchema],
  transactions: [transactionSchema]
});

const Caisse = mongoose.model("Caisse", caisseSchema);
module.exports = Caisse;