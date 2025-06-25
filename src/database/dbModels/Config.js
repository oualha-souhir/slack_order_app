const mongoose = require("mongoose");

const ConfigSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true }, 
  values: { type: [String], default: [] },
});

const Config = mongoose.model("Config", ConfigSchema);
module.exports = Config;