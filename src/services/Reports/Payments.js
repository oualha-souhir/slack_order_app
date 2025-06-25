const PaymentRequest = require("../../database/dbModels/PaymentRequest");
const axios = require("axios");
const ExcelJS = require("exceljs");
const querystring = require("querystring");
const { formatDate } = require("./Common");

// Function to generate a payment report based on payment ID, project, or date
async function exportPaymentReport(
	context,
	reportType,
	value,
	userId,
	channelId
) {
	try {
		console.log(
			`Generating payment report: type=${reportType}, value=${value}, userId=${userId}`
		);

		let reportData = [];
		let reportTitle = "";
		let worksheetName = "";

		// Query based on report type
		switch (reportType.toLowerCase()) {
			case "payment": {
				reportTitle = `Payment Report - ${value}`;
				worksheetName = `Payment`;
				const payment = await PaymentRequest.findOne({
					id_paiement: value,
				}).lean();
				if (!payment) {
					throw new Error(`Payment ${value} not found or is deleted`);
				}
				reportData = [payment];
				break;
			}
			case "channel": {
				reportTitle = `Project Payment Report`;
				worksheetName = `Project_${value}`;
				const match = value.match(/<#\w+\|([^>]+)>|#?(\w[\w-]*)/);
				value = match ? match[1] || match[2] : value;
				console.log("value", value);
				reportData = await PaymentRequest.find({ id_projet: value })
					.sort({ date: -1 })
					.lean();
				if (reportData.length === 0) {
					throw new Error(`No payments found for project ${value}`);
				}
				break;
			}
			case "date": {
				reportTitle = `Daily Payment Report - ${value}`;
				worksheetName = `PaymentDate_${value}`;
				const startDate = new Date(value);
				console.log("aaaa");

				console.log(startDate);
				const endDate = new Date(startDate);
				console.log(endDate);
				endDate.setDate(endDate.getDate() + 1);
				reportData = await PaymentRequest.find({
					date: { $gte: startDate, $lt: endDate },
				})
					.sort({ date: -1 })
					.lean();
				console.log(reportData);

				if (reportData.length === 0) {
					throw new Error(`No payments found for date ${value}`);
				}
				break;
			}
			case "status": {
				reportTitle = `Payment Status Report - ${value}`;
				worksheetName = `Status_${value}`;
				reportData = await PaymentRequest.find({ statut: value })
					.sort({ date: -1 })
					.lean();
				if (reportData.length === 0) {
					throw new Error(`No payments found with status ${value}`);
				}
				break;
			}
			case "user": {
				reportTitle = `User Orders Report - ${value}`;
				worksheetName = `User_${value}`;
				// If value looks like a Slack mention or username, resolve to user ID
				if (value.startsWith("@")) {
					const username = value.replace(/^../, "").trim();
					try {
						const usersResp = await axios.get(
							"https://slack.com/api/users.list",
							{
								headers: {
									Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
								},
							}
						);
						if (usersResp.data.ok) {
							const userObj = usersResp.data.members.find(
								(u) =>
									u.name === username ||
									(u.profile && u.profile.display_name === username) ||
									(u.profile && u.profile.real_name === username)
							);
							if (userObj) {
								value = userObj.id; // Use Slack user ID for the query
							}
						}
					} catch (err) {
						context.log(`Failed to resolve Slack user: ${err.message}`);
					}
				}
				reportData = await PaymentRequest.find({ demandeurId: value })
					.sort({ date: -1 })
					.lean();
				if (reportData.length === 0) {
					throw new Error(`No payments found for user ${value}`);
				}

				break;
			}
			default:
				throw new Error(
					'Invalid report type. Use "payment", "project", "date", "status", or "user".'
				);
		}

		context.log(`Retrieved ${reportData.length} payment records for report`);

		// Create Excel workbook
		const workbook = new ExcelJS.Workbook();
		const worksheet = workbook.addWorksheet(worksheetName);

		// Define columns for payment request data
		worksheet.columns = [
			{ header: "Payment ID", key: "id_paiement", width: 20 },
			{ header: "Title", key: "titre", width: 30 },
			{ header: "Status", key: "statut", width: 20 },
			{ header: "Requester", key: "demandeur", width: 20 },
			{ header: "Project/Channel", key: "project", width: 20 },
			{ header: "Request Date", key: "date", width: 30 },
			{ header: "Required Date", key: "date_requete", width: 30 },
			{ header: "Reason/Motif", key: "motif", width: 40 },
			{ header: "Reference", key: "bon_de_commande", width: 20 },
			{ header: "Justifications", key: "justificatifs", width: 50 },
			{ header: "Total Amount", key: "totalAmount", width: 15 },
			{ header: "Amount Paid", key: "amountPaid", width: 15 },
			{ header: "Last Payment Amount", key: "lastPaymentAmount", width: 15 },
			{ header: "Remaining Amount", key: "remainingAmount", width: 15 },
			{ header: "Payment Details", key: "paymentDetails", width: 60 }, // Includes Payment Modes, Currency, Last Payment Date
			{ header: "Rejection Reason", key: "rejection_reason", width: 30 },
		];

		// Enable text wrapping for all columns
		worksheet.columns.forEach((column) => {
			column.alignment = { wrapText: true, vertical: "top" };
		});

		// Format data for Excel
		for (const payment of reportData) {
			// Calculate payment amounts
			const totalAmount = payment.montant || 0;
			const totalAmountPaid = payment.amountPaid || 0;
			const remainingAmount =
				payment.remainingAmount || totalAmount - totalAmountPaid;
			const lastAmountPaid = payment.payments?.length
				? payment.payments[payment.payments.length - 1].amountPaid || 0
				: 0;

			// Get channel name for project
			let channelName = "";
			if (payment.project) {
				try {
					const result = await axios.post(
						"https://slack.com/api/conversations.info",

						querystring.stringify({ channel: payment.project }),
						{
							headers: {
								Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
								"Content-Type": "application/x-www-form-urlencoded",
							},
						}
					);
					if (result.data.ok) {
						channelName = result.data.channel.name;
					} else {
						context.log(`Failed to get channel info: ${result.data.error}`);
					}
				} catch (error) {
					context.log(`Failed to get channel name: ${error.message}`);
				}
			}
			console.log("channelName", channelName);
			console.log("payment.project", payment.project);

			// Get requester name
			let demandeur = "";
			if (payment.demandeurId) {
				try {
					const result = await axios.post(
						"https://slack.com/api/users.info",

						querystring.stringify({ user: payment.demandeurId }),
						{
							headers: {
								Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
								"Content-Type": "application/x-www-form-urlencoded",
							},
						}
					);
					if (result.data.ok) {
						// eslint-disable-next-line no-unused-vars
						demandeur =
							result.data.user.name || result.data.user.real_name || "";
					}
				} catch (error) {
					context.log(`Failed to get demandeur user name: ${error.message}`);
				}
			}

			// Format payment modes
			let paymentModes = "";
			if (payment.payments?.length) {
				// eslint-disable-next-line no-unused-vars
				paymentModes = payment.payments
					.map((p) => p.paymentMode || "")
					.filter((mode) => mode)
					.join("\n");
			}

			let paymentDetails = "";
			if (payment.payments?.length) {
				paymentDetails = payment.payments
					.map((p) => {
						const title = p.paymentTitle || "";
						const amount = p.amountPaid ? `${p.amountPaid}` : "";

						const date = p.dateSubmitted
							? `(${formatDate(p.dateSubmitted)})`
							: "";
						const mode = p.paymentMode ? `Mode: ${p.paymentMode}` : "";
						const currency = payment.devise || "XOF";
						const details = p.details
							? Object.entries(p.details)
									.map(([key, value]) => `${key}: ${value}`)
									.join(" | ")
							: "";
						const proofs = p.paymentProofs?.length
							? `\n   📎 Proof: ${p.paymentProofs.join("\n   📎 ")}`
							: "";
						const url = p.paymentUrl ? `\n   🔗 ${p.paymentUrl}` : "";
						const detailsLine = details ? `\n   Details: ${details}` : "";
						return `• ${title}: ${amount} ${currency} ${date}\n   ${mode}${detailsLine}${proofs}${url}`;
					})
					.join("\n\n");
			}

			// Format justifications
			let justificatifs = payment.justificatif?.length
				? payment.justificatif.map((doc) => `📄 ${doc.url}`).join("\n")
				: "";

			// Get last payment date

			// const lastPaymentDate = payment.payments?.length
			// 	? formatDate(
			// 			[...payment.payments].sort(
			// 				(a, b) => new Date(b.dateSubmitted) - new Date(a.dateSubmitted)
			// 			)[0].dateSubmitted
			// 	  )
			// 	: "";

			const row = {
				id_paiement: payment.id_paiement || "",
				titre: payment.titre || "",
				statut: payment.statut || "En attente",
				demandeur: payment.demandeur || "",
				project: payment.project || "",
				date: new Date(payment.date).toLocaleString("fr-FR", {
					weekday: "long",
					year: "numeric",
					month: "long",
					day: "numeric",
					hour: "2-digit",
					minute: "2-digit",
					timeZoneName: "short",
				}),
				date_requete: payment.date_requete
					? new Date(payment.date_requete).toLocaleString("fr-FR", {
							weekday: "long",
							year: "numeric",
							month: "long",
							day: "numeric",
					  })
					: "",
				motif: payment.motif || "",
				bon_de_commande: payment.bon_de_commande || "",
				justificatifs: justificatifs,
				totalAmount: totalAmount.toString(),
				amountPaid: totalAmountPaid.toString(),
				lastPaymentAmount: lastAmountPaid.toString(),
				remainingAmount: remainingAmount.toString(),
				paymentDetails: paymentDetails, // Includes payment modes, currency, and last payment date
			};
			worksheet.addRow(row);
		}

		// Style the header
		worksheet.getRow(1).font = { bold: true };
		worksheet.getRow(1).fill = {
			type: "pattern",
			pattern: "solid",
			fgColor: { argb: "FFB6E5B6" }, // Light green color to differentiate from order reports
		};

		// Enable text wrapping for all rows
		worksheet.eachRow((row) => {
			row.eachCell((cell) => {
				cell.alignment = { wrapText: true, vertical: "top" };
			});
		});

		// Save the workbook to a buffer
		const buffer = await workbook.xlsx.writeBuffer();
		const fileName = `${worksheetName}_${Date.now()}.xlsx`;

		// Use the provided channel ID directly
		if (!channelId) {
			throw new Error("No channel ID provided for file upload");
		}
		context.log(`Using channel for upload: ${channelId}`);

		// Step 1: Get upload URL from Slack

		const uploadUrlResponse = await axios.post(
			"https://slack.com/api/files.getUploadURLExternal",
			{
				filename: fileName,

				length: buffer.length.toString(),
				content_type:
					"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			},
			{
				headers: {
					Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
					"Content-Type": "application/x-www-form-urlencoded",
				},
			}
		);

		if (!uploadUrlResponse.data.ok) {
			context.log(
				`Failed to get upload URL: ${JSON.stringify(uploadUrlResponse.data)}`
			);
			throw new Error(
				`Failed to get upload URL: ${uploadUrlResponse.data.error}`
			);
		}

		const { upload_url, file_id } = uploadUrlResponse.data;
		context.log(`Upload URL obtained: ${upload_url}, file_id: ${file_id}`);

		// Step 2: Upload the file to the provided URL
		const form = new FormData();

		form.append("file", buffer, {
			filename: fileName,
			contentType:
				"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		});

		const uploadResponse = await axios.post(upload_url, form, {
			headers: {
				...form.getHeaders(),
			},
		});

		if (uploadResponse.status !== 200) {
			context.log(
				`Upload failed: status=${
					uploadResponse.status
				}, response=${JSON.stringify(uploadResponse.data)}`
			);
			throw new Error(
				`Failed to upload file to Slack URL: ${uploadResponse.statusText}`
			);
		}
		context.log(`File uploaded to Slack URL successfully`);

		// Step 4: Complete the upload
		const truncatedTitle = reportTitle.substring(0, 250); // Ensure title is within 255 chars

		const completeResponse = await axios.post(
			"https://slack.com/api/files.completeUploadExternal",
			{
				files: [
					{
						id: file_id,
						title: truncatedTitle,
					},
				],
				channel_id: channelId,
				initial_comment: `Here is your ${truncatedTitle}`,
			},
			{
				headers: {
					Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
					"Content-Type": "application/json",
				},
			}
		);

		if (!completeResponse.data.ok) {
			context.log(
				`Failed to complete upload: ${JSON.stringify(completeResponse.data)}`
			);
			throw new Error(
				`Failed to complete file upload: ${completeResponse.data.error}`
			);
		}

		context.log(
			`Payment report ${reportTitle} generated and uploaded successfully for user ${userId} in channel ${channelId}`
		);
		return {
			success: true,
			message: `Payment report ${reportTitle} sent to user`,
		};
	} catch (error) {
		context.log(
			`Error generating payment report: ${error.message}, stack: ${error.stack}`
		);
		throw error;
	}
}
module.exports = {
	exportPaymentReport,
};
