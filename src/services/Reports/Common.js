// Format dates safely
const formatDate = (date) => {
	if (!date || isNaN(new Date(date).getTime())) return "";
	return new Date(date).toISOString().split("T")[0];
};
module.exports = {
	formatDate,
};