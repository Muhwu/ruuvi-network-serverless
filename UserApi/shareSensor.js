const gatewayHelper = require('../Helpers/gatewayHelper');
const auth = require('../Helpers/authHelper');
const validator = require('../Helpers/validator');
const userHelper = require('../Helpers/userHelper');
const emailHelper = require('../Helpers/emailHelper');
const sqlHelper = require('../Helpers/sqlHelper');
const dynamoHelper = require('../Helpers/dynamoHelper');
const errorCodes = require('../Helpers/errorCodes');

const mysql = require('serverless-mysql')({
    config: {
        host     : process.env.DATABASE_ENDPOINT,
        database : process.env.DATABASE_NAME,
        user     : process.env.DATABASE_USERNAME,
        password : process.env.DATABASE_PASSWORD
    }
});

exports.handler = async (event, context) => {
    const user = await auth.authorizedUser(event.headers);
    if (!user) {
        return gatewayHelper.unauthorizedResponse();
    }

    const eventBody = JSON.parse(event.body);

    if (!eventBody || !validator.hasKeys(eventBody, ['sensor', 'user'])) {
        return gatewayHelper.errorResponse(gatewayHelper.HTTPCodes.INVALID, "Missing sensor or e-mail.", errorCodes.ER_MISSING_ARGUMENT);
    }

    const sensor = eventBody.sensor;
    const targetUserEmail = eventBody.user;

    if (!validator.validateEmail(targetUserEmail)) {
        return gatewayHelper.errorResponse(gatewayHelper.HTTPCodes.INVALID, "Invalid E-mail given.", errorCodes.ER_INVALID_EMAIL_ADDRESS);
    }

    if (!validator.validateMacAddress(sensor)) {
        return gatewayHelper.errorResponse(gatewayHelper.HTTPCodes.INVALID, "Invalid sensor ID given.", errorCodes.ER_INVALID_MAC_ADDRESS);
    }

    let results = null;

    try {
        const targetUser = await userHelper.getByEmail(targetUserEmail);
        if (!targetUser) {
            return gatewayHelper.errorResponse(gatewayHelper.HTTPCodes.NOT_FOUND, "User not found.", errorCodes.ER_USER_NOT_FOUND);
        }

        // Get Subscription
        const subscription = await sqlHelper.fetchSingle('user_id', user.id, 'subscriptions');
        if (!subscription) {
            return gatewayHelper.errorResponse(gatewayHelper.HTTPCodes.INVALID, 'No subscription found.', errorCodes.ER_SUBSCRIPTION_NOT_FOUND);
        }
        const maxShares = parseInt(subscription.max_shares);
        const maxSharesPerSensor = parseInt(subscription.max_shares_per_sensor);

        const currentShares = await mysql.query({
            sql: `SELECT
                    COUNT(*) AS sensor_count,
                    SUM(IF(sensors.sensor_id = ?, 1, 0)) AS single_sensor_shares
                FROM sensor_profiles
                INNER JOIN sensors ON sensors.sensor_id = sensor_profiles.sensor_id
                INNER JOIN users ON users.id = sensor_profiles.user_id
                WHERE
                    sensors.owner_id = ?
                    AND sensor_profiles.user_id != ?`,
            timeout: 1000,
            values: [sensor, user.id, user.id]
        });

        if (currentShares[0].sensor_count >= maxShares) {
            return gatewayHelper.errorResponse(gatewayHelper.HTTPCodes.INVALID, 'Maximum share count for subscription reached.', errorCodes.ER_SHARE_COUNT_REACHED);
        }

        if (currentShares[0].single_sensor_shares >= maxSharesPerSensor) {
            return gatewayHelper.errorResponse(gatewayHelper.HTTPCodes.INVALID, `Maximum share (${maxSharesPerSensor}) count reached for sensor ${sensor}.`, errorCodes.ER_SENSOR_SHARE_COUNT_REACHED);
        }

        const data = await dynamoHelper.getSensorData(sensor, 1, null, null);
        if (data.length === 0) {
            return gatewayHelper.errorResponse(gatewayHelper.HTTPCodes.INVALID, 'Cannot share a sensor without data.', errorCodes.ER_NO_DATA_TO_SHARE);
        }

        const targetUserId = targetUser.id;

        // Currently Enforces sharing restrictions on database level
        console.log(user.id + ' shared sensor ' + sensor + ' to ' + targetUserId);
        results = await mysql.query({
            sql: `INSERT INTO sensor_profiles (
                    user_id,
                    sensor_id,
                    name,
                    picture
                ) SELECT
                    ?,
                    sensor_id,
                    '',
                    ''
                FROM sensors
                WHERE
                    sensors.owner_id = ?
                    AND sensors.owner_id != ?
                    AND sensors.sensor_id = ?`,
            timeout: 1000,
            values: [targetUserId, user.id, targetUserId, sensor]
        });

        if (results.insertId) {
            // Success
        } else {
            return gatewayHelper.errorResponse(gatewayHelper.HTTPCodes.INVALID, "Unable to share sensor.", errorCodes.ER_INTERNAL, errorCodes.ER_SUB_DATA_STORAGE_ERROR);
        }

        // Run clean up function
        await mysql.end();
    } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') {
            return gatewayHelper.errorResponse(gatewayHelper.HTTPCodes.CONFLICT, "Sensor already shared to user.", errorCodes.ER_SENSOR_ALREADY_SHARED);
        }

        return gatewayHelper.errorResponse(gatewayHelper.HTTPCodes.INTERNAL, "Unknown error occurred.", errorCodes.ER_INTERNAL);
    }

    // Sharing was successful, send notification e-mail
    try {
        const sensorData = await mysql.query({
            sql: `SELECT name
                FROM sensor_profiles
                INNER JOIN sensors ON sensors.sensor_id = sensor_profiles.sensor_id
                WHERE
                    sensors.owner_id = sensor_profiles.user_id
                    AND sensor_profiles.is_active = 1
                    AND sensor_profiles.sensor_id = ?`,
            timeout: 1000,
            values: [sensor]
        });

        if (sensorData.length === 0) {
            return gatewayHelper.errorResponse(gatewayHelper.HTTPCodes.INTERNAL, 'Share successful, but unable to send e-mail.', errorCodes.ER_UNABLE_TO_SEND_EMAIL, errorCodes.ER_SUB_DATA_STORAGE_ERROR);
        }

        const sensorName = sensorData[0].name ? sensorData[0].name : 'unnamed';

        await emailHelper.sendShareNotification(
            targetUserEmail,
            sensorName,
            user.email,
            process.env.SOURCE_EMAIL,
            process.env.SOURCE_DOMAIN
        );
    } catch (e) {
        console.error(e.message);
        return gatewayHelper.errorResponse(gatewayHelper.HTTPCodes.INVALID, "Share successful. Failed to send notification.", errorCodes.ER_UNABLE_TO_SEND_EMAIL);
    }

    return gatewayHelper.successResponse({
        sensor: sensor
    });
}
