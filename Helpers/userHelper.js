const mysql = require('serverless-mysql')({
    config: {
        host     : process.env.DATABASE_ENDPOINT,
        database : process.env.DATABASE_NAME,
        user     : process.env.DATABASE_USERNAME,
        password : process.env.DATABASE_PASSWORD
    }
});

/**
 * Fetches a user by e-mail
 *
 * @param {string} email E-mail address of the fetched user
 */
const getByEmail = async (email) => {
    const validator = require('../Helpers/validator');
    if (!validator.validateEmail(email)) {
        return null;
    }

    try {
        const existingUser = await mysql.query(
            `SELECT *
            FROM users
            WHERE email = '${email}'`
        );

        if (existingUser.length === 1) {
            return existingUser[0];
        }
    } catch (err) {
        console.error(err);
        return null;
    }
    return null;
}

/**
 * Fetches a user by id
 *
 * @param {int} id ID of the fetched user
 */
const getById = async (id) => {
    const idInt = parseInt(id);
    if (!idInt) {
        return null;
    }

    try {
        const existingUser = await mysql.query(
            `SELECT *
            FROM users
            WHERE id = ${id}`
        );

        if (existingUser.length === 1) {
            return existingUser[0];
        }
    } catch (err) {
        console.error(err);
        return null;
    }
    return null;
}

/**
 * Create user by e-mail
 *
 * @param {string} email Email of the created user
 */
const create = async (email) => {
    const validator = require('../Helpers/validator');
    if (!validator.validateEmail(email)) {
        return null;
    }

    try {
        results = await mysql.query(
            `INSERT INTO users (
                email
            ) VALUES (
                '${email}'
            );`
        );
        return results.insertId;
    } catch (err) {
        console.error(err);
        return null;
    }
}

/**
 * Create user token for user
 *
 * @param {int} userId ID of the user
 * @param {string} token Token to store
 */
const createToken = async (userId) => {
    const idInt = parseInt(userId);
    if (!idInt) {
        return null;
    }

    const guidHelper = require('../Helpers/guidHelper');
    const token = guidHelper.guid(64);

    try {
        results = await mysql.query(
            `INSERT INTO user_tokens (
                user_id,
                access_token
            ) VALUES (
                ${idInt},
                '${token}'
            );`
        );
        return token;
    } catch (err) {
        console.error(err);
        return null;
    }
}


/**
 * Exports
 */
module.exports = {
    getByEmail,
    getById,
    create,
    createToken
 };