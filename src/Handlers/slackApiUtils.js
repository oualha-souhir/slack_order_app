const {
	getProformaBlocks,
	getOrderBlocks,
} = require("../services/Order/blockBuilders");
const { getPaymentRequestBlocks } = require("../services/Payment/blockBuilder");
const axios = require("axios");
const crypto = require("crypto");

// You may need to adjust this function to match your actual implementation
async function postSlackMessageWithRetry(
	url,
	body,
	token,
	context,
	retries = 3
) {
	console.log("** postSlackMessageWithRetry");

	// Add token validation
	if (!token) {
		throw new Error("Slack bot token is missing");
	}

	let lastError = null;
	console.log(`Sending Slack message: ${JSON.stringify(body)}`);

	for (let attempt = 1; attempt <= retries; attempt++) {
		try {
			const response = await axios.post(url, body, {
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				timeout: 10000, // Add timeout
			});

			if (attempt > 1) {
				console.log(`Success on retry attempt ${attempt}`);
			}

			return response.data;
		} catch (error) {
			lastError = error;
			console.log(`Attempt ${attempt} failed: ${error.message}`);

			if (attempt < retries) {
				await new Promise((resolve) =>
					setTimeout(resolve, 100 * Math.pow(2, attempt - 1))
				);
			}
		}
	}

	throw lastError || new Error("All retries failed with unknown error");
}
async function updateSlackPaymentMessage(messageTs, orderId, status, order) {
	console.log("** updateSlackPaymentMessage");

	console.log("orderId", orderId);
	console.log("status", status);
	console.log("order", order);
	console.log("messageTs", messageTs);

	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.update",
		{
			channel: process.env.SLACK_ADMIN_ID,
			ts: messageTs,
			text: `Demande *${orderId}* - *${status}*`,
			blocks: [
				...getPaymentRequestBlocks(order, order.demandeurId),
				{
					type: "section",
					text: {
						type: "mrkdwn",
						text: `✅ Demande *${status}* avec succèes`,
					},
				},

				// {
				//   type: "actions",
				//   elements: [
				//     {
				//       type: "button",
				//       text: { type: "plain_text", text: "Rouvrir" },
				//       action_id: "reopen_order",
				//       value: orderId
				//     }
				//   ]
				// }
			],
		},
		process.env.SLACK_BOT_TOKEN
	);
}
async function updateSlackMessageAcceptance(messageTs, orderId, status, order) {
	console.log("** updateSlackMessageAcceptance");
	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.update",
		{
			channel: process.env.SLACK_ADMIN_ID,
			ts: messageTs,
			text: `Demande *${orderId}* - *${status}*`,
			blocks: [
				...getOrderBlocks(order),
				...getProformaBlocks(order),

				{
					type: "section",
					text: {
						type: "mrkdwn",
						text: `✅ Demande *${status}* avec succèes`,
					},
				},

				// {
				//   type: "actions",
				//   elements: [
				//     {
				//       type: "button",
				//       text: { type: "plain_text", text: "Rouvrir" },
				//       action_id: "reopen_order",
				//       value: orderId
				//     }
				//   ]
				// }
			],
		},
		process.env.SLACK_BOT_TOKEN
	);
}

function createSlackResponse(statusCode, content, options = {}) {
	console.log("** createSlackResponse");

	let body;
	if (typeof content === "string" && !options.skipEphemeral) {
		body = JSON.stringify({
			response_type: "ephemeral",
			text: content,
		});
	} else {
		body = JSON.stringify(content);
	}

	return {
		statusCode,
		headers: { "Content-Type": "application/json" },
		body,
	};
}

function verifySlackSignature(request, body) {
	console.log("** verifySlackSignature");
	const slackSigningSecret = process.env.SLACK_SIGNING_SECRET;
	const requestSignature = request.headers.get("x-slack-signature");
	const requestTimestamp = request.headers.get("x-slack-request-timestamp");

	const sigBasestring = `v0:${requestTimestamp}:${body}`;
	const mySignature =
		"v0=" +
		crypto
			.createHmac("sha256", slackSigningSecret)
			.update(sigBasestring)
			.digest("hex");

	return crypto.timingSafeEqual(
		Buffer.from(mySignature, "utf8"),
		Buffer.from(requestSignature, "utf8")
	);
}
async function getFileInfo(fileId, token) {
	console.log("** getFileInfo");

	const response = await axios.get("https://slack.com/api/files.info", {
		params: { file: fileId },
		headers: { Authorization: `Bearer ${token}` },
	});
	return response.data.file;
}

module.exports = {
	updateSlackPaymentMessage,
	updateSlackMessageAcceptance,
	verifySlackSignature,
	getFileInfo,
	postSlackMessageWithRetry,
	createSlackResponse,
};
