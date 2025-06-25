const Caisse = require("./dbModels/Caisse");
const FormData1 = require("./dbModels/FormData1");
const Order = require("./dbModels/Order");
const PaymentRequest = require("./dbModels/PaymentRequest");
const mongoose = require("mongoose"); // For MongoDB operations

async function saveToStorage(key, data) {
	try {
		console.log("** saveToStorage");
		const result = await FormData1.create({ key, data });
		console.log(`Stored form data in MongoDB with key: ${key}`);
		return result;
	} catch (err) {
		console.log(`Error saving form data for key ${key}:`, err);
		throw err;
	}
}

// Helper function to fetch an entity (order or payment request)
async function fetchEntity(entityId, context) {
	console.log("** fetchEntity");
	try {
		// For orders (CMD/xxx)
		if (entityId.startsWith("CMD/")) {
			return await Order.findOne({ id_commande: entityId });
		}
		// For payment requests (PAY/xxx)
		else if (entityId.startsWith("PAY/")) {
			return await PaymentRequest.findOne({ id_paiement: entityId });
		} else if (entityId.startsWith("FUND/")) {
			return await Caisse.findOne({
				"fundingRequests.requestId": entityId,
			});
		}
		// Invalid entity ID format
		else {
			context.log(`Invalid entity ID format: ${entityId}`);
			return null;
		}
	} catch (error) {
		context.log(`Error fetching entity ${entityId}: ${error.message}`);
		throw new Error(`Failed to fetch entity: ${error.message}`);
	}
}
// // Helper to fetch order or payment request
// async function fetchEntity(id, context) {
// 	console.log("** fetchEntity");
// 	console.log("id1", id);
// 	let entity;
// 	// Ensure id is a string; convert it if possible, or handle invalid cases
// 	if (typeof id !== "string") {
// 		if (id && typeof id === "object" && id.id_paiement) {
// 			id = id.id_paiement; // Extract id_paiement if id is an object
// 		} else {
// 			context.log(`❌ Invalid id provided: ${id}`);
// 			return null; // Or throw an error, depending on your needs
// 		}
// 	}
// 	if (id.startsWith("CMD/")) {
// 		entity = await Order.findOne({ id_commande: id });
// 		if (!entity) context.log(`❌ Order ${id} not found`);
// 	} else if (id.startsWith("PAY/")) {
// 		entity = await PaymentRequest.findOne({ id_paiement: id });
// 		if (!entity) context.log(`❌ Payment request ${id} not found`);
// 	}
// 	return entity;
// }
// Update the saveMessageReference function to include a message type
async function saveMessageReference(
	orderId,
	messageTs,
	channelId,
	messageType = "admin"
) {
	console.log("** saveMessageReference");
	try {
		// Define a schema for message references if not already defined
		if (!mongoose.models.MessageReference) {
			const MessageReferenceSchema = new mongoose.Schema({
				orderId: { type: String, required: true },
				messageTs: { type: String, required: true },
				channelId: { type: String, required: true },
				messageType: { type: String, required: true, default: "admin" },
				updatedAt: { type: Date, default: Date.now },
			});
			mongoose.model("MessageReference", MessageReferenceSchema);
		}

		const MessageReference = mongoose.model("MessageReference");

		// Try to update existing reference first
		const result = await MessageReference.findOneAndUpdate(
			{ orderId, messageType },
			{ messageTs, channelId, updatedAt: new Date() },
			{ new: true, upsert: false }
		);

		// If no document was updated, create a new one
		if (!result) {
			await MessageReference.create({
				orderId,
				messageTs,
				channelId,
				messageType,
				updatedAt: new Date(),
			});
		}

		return true;
	} catch (error) {
		console.error(`Error saving message reference: ${error.message}`);
		return false;
	}
}

// Update the getMessageReference function to filter by message type
async function getMessageReference(orderId, messageType = "admin") {
	console.log("** getMessageReference");
	try {
		if (!mongoose.models.MessageReference) {
			return null;
		}

		const MessageReference = mongoose.model("MessageReference");
		return await MessageReference.findOne({ orderId, messageType });
	} catch (error) {
		console.error(`Error retrieving message reference: ${error.message}`);
		return null;
	}
}
async function saveOrderMessageToDB(orderId, messageDetails) {
	console.log("** saveOrderMessageToDB");
	try {
		const order = await Order.findOne({ id_commande: orderId });
		if (!order) return false;
		if (!order.slackMessages) {
			order.slackMessages = [];
		}
		order.slackMessages = [
			{
				channel: messageDetails.channel,
				ts: messageDetails.ts,
				messageType: "notification",
				createdAt: new Date(),
			},
		];
		await order.save();
		return true;
	} catch (error) {
		console.error("Error saving order message to DB:", error);
		return false;
	}
}

async function getOrderMessageFromDB(orderId) {
	console.log("** getOrderMessageFromDB");
	try {
		const order = await Order.findOne({ id_commande: orderId });
		if (!order || !order.slackMessages?.length) return null;
		return {
			channel: order.slackMessages[0].channel,
			ts: order.slackMessages[0].ts,
			orderId,
		};
	} catch (error) {
		console.error("Error retrieving order message from DB:", error);
		return null;
	}
}
module.exports = {
	saveToStorage,
	fetchEntity,
	saveMessageReference,
	getMessageReference,
	saveOrderMessageToDB,
	getOrderMessageFromDB,
};
