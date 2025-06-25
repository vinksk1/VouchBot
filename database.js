const mongoose = require('mongoose');
const { generateVouchId } = require('./utils');

const vouchSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  vouchedBy: { type: String, required: true },
  points: { type: Number, required: true, min: 0, max: 50000 },
  message: { type: String, required: true, maxlength: 500 },
  timestamp: { type: Date, default: Date.now },
  deleted: { type: Boolean, default: false },
  vouchId: { type: String, unique: true, default: generateVouchId }
});

vouchSchema.index({ userId: 1, deleted: 1 });
vouchSchema.index({ vouchedBy: 1, deleted: 1 });
vouchSchema.index({ timestamp: 1, deleted: 1 });

const Vouch = mongoose.model('Vouch', vouchSchema);

async function initializeDatabase() {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 30000,
      heartbeatFrequencyMS: 10000
    });
    console.log(`MongoDB connected`);
    mongoose.connection.on('disconnected', () => console.log('MongoDB disconnected'));
    mongoose.connection.on('reconnected', () => console.log('MongoDB reconnected'));
  } catch (err) {
    console.error(`MongoDB connection failed:`, err.message);
    process.exit(1);
  }
}

module.exports = { Vouch, initializeDatabase };