const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();

// CORS для Telegram
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type']
}));

app.use(express.json());

// Подключение к базе
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

pool.connect()
    .then(() => console.log('→ PostgreSQL подключён успешно'))
    .catch(err => {
        console.error('Ошибка подключения к PostgreSQL:', err.message);
        process.exit(1);
    });

// Создание таблиц
async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS cars (
                id                        SERIAL PRIMARY KEY,
                user_id                   TEXT NOT NULL,
                car_name                  TEXT NOT NULL,
                reg_number                TEXT,
                mileage                   INTEGER DEFAULT 0,
                mileage_last_oil_change   INTEGER DEFAULT 0,
                oil_change_interval       INTEGER DEFAULT 10000,
                created_at                TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS fuel_records (
                id              SERIAL PRIMARY KEY,
                car_id          INTEGER NOT NULL REFERENCES cars(id) ON DELETE CASCADE,
                amount          REAL NOT NULL,
                liters          REAL NOT NULL,
                price_per_liter REAL NOT NULL,
                mileage         INTEGER NOT NULL,
                full_tank       INTEGER DEFAULT 0,
                station_name    TEXT,
                comments        TEXT,
                date            TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS car_expenses (
                id         SERIAL PRIMARY KEY,
                car_id     INTEGER NOT NULL REFERENCES cars(id) ON DELETE CASCADE,
                category   TEXT NOT NULL,
                amount     REAL NOT NULL,
                mileage    INTEGER,
                comments   TEXT,
                date       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        console.log('✅ База готова');
    } catch (err) {
        console.error('Ошибка инициализации базы:', err.message);
    }
}

initDB().catch(console.error);

// Middleware для проверки Telegram ID
function validateTelegramId(req, res, next) {
    const userId = req.params.userId || req.body.user_id || req.query.user_id;
    
    // Проверяем, что ID начинается с tg_ (наш формат)
    if (!userId || !userId.startsWith('tg_')) {
        console.log('❌ Невалидный Telegram ID:', userId);
        return res.status(401).json({ error: 'Недействительный Telegram ID' });
    }
    
    console.log('✅ Telegram ID валидный:', userId);
    next();
}

// Получить автомобили пользователя
app.get('/cars/:userId', validateTelegramId, async (req, res) => {
    const { userId } = req.params;
    console.log(`GET /cars/${userId}`);
    
    try {
        const result = await pool.query(
            'SELECT * FROM cars WHERE user_id = $1 ORDER BY created_at DESC',
            [userId]
        );
        res.json(result.rows);
    } catch (e) {
        console.error('Ошибка:', e.message);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Добавить автомобиль
app.post('/add-car', validateTelegramId, async (req, res) => {
    console.log('POST /add-car', req.body);
    
    const { user_id, car_name, reg_number, mileage = 0 } = req.body;
    
    if (!car_name) {
        return res.status(400).json({ error: 'Название автомобиля обязательно' });
    }
    
    try {
        const result = await pool.query(
            `INSERT INTO cars (user_id, car_name, reg_number, mileage, mileage_last_oil_change, oil_change_interval)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [user_id, car_name, reg_number || null, mileage, mileage, 10000]
        );
        
        res.json(result.rows[0]);
    } catch (e) {
        console.error('Ошибка:', e.message);
        res.status(500).json({ error: 'Ошибка при добавлении' });
    }
});

// Обновить автомобиль
app.put('/update-car/:id', validateTelegramId, async (req, res) => {
    const { id } = req.params;
    const { car_name, reg_number, mileage, mileage_last_oil_change, oil_change_interval, user_id } = req.body;

    try {
        const result = await pool.query(
            `UPDATE cars
             SET car_name = $1, reg_number = $2, mileage = $3, mileage_last_oil_change = $4, oil_change_interval = $5
             WHERE id = $6 AND user_id = $7 RETURNING *`,
            [car_name, reg_number, mileage, mileage_last_oil_change, oil_change_interval, id, user_id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Авто не найдено' });
        }

        res.json(result.rows[0]);
    } catch (e) {
        console.error('Ошибка:', e.message);
        res.status(500).json({ error: 'Ошибка при обновлении' });
    }
});

// Удалить автомобиль
app.delete('/cars/:id', validateTelegramId, async (req, res) => {
    const { id } = req.params;
    const { user_id } = req.body;

    try {
        await pool.query('DELETE FROM fuel_records WHERE car_id = $1', [id]);
        await pool.query('DELETE FROM car_expenses WHERE car_id = $1', [id]);
        const result = await pool.query('DELETE FROM cars WHERE id = $1 AND user_id = $2', [id, user_id]);

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Авто не найдено' });
        }

        res.json({ success: true });
    } catch (e) {
        console.error('Ошибка:', e.message);
        res.status(500).json({ error: 'Ошибка при удалении' });
    }
});

// Дашборд
app.get('/dashboard/:carId', validateTelegramId, async (req, res) => {
    const { carId } = req.params;
    const userId = req.query.user_id;

    try {
        const carRes = await pool.query('SELECT * FROM cars WHERE id = $1 AND user_id = $2', [carId, userId]);
        const car = carRes.rows[0];
        if (!car) {
            return res.status(404).json({ error: 'Авто не найдено' });
        }

        const fuelRes = await pool.query(
            `SELECT id, 'fuel' AS type, '⛽ Заправка' AS category, amount, liters, price_per_liter, 
                    mileage, full_tank, station_name, comments, date
             FROM fuel_records WHERE car_id = $1`,
            [carId]
        );

        const expRes = await pool.query(
            `SELECT id, 'expense' AS type, category, amount, mileage, comments, date
             FROM car_expenses WHERE car_id = $1`,
            [carId]
        );

        const history = [...fuelRes.rows, ...expRes.rows].sort(
            (a, b) => new Date(b.date) - new Date(a.date)
        );

        res.json({ car, history });
    } catch (e) {
        console.error('Ошибка:', e.message);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Добавить заправку
app.post('/add-fuel', validateTelegramId, async (req, res) => {
    try {
        const { car_id, amount, liters, mileage, full_tank, station_name, comments, user_id } = req.body;

        // Проверяем, что машина принадлежит пользователю
        const carCheck = await pool.query('SELECT id FROM cars WHERE id = $1 AND user_id = $2', [car_id, user_id]);
        if (carCheck.rowCount === 0) {
            return res.status(403).json({ error: 'Доступ запрещен' });
        }

        const ppl = amount / liters;

        const result = await pool.query(
            `INSERT INTO fuel_records (car_id, amount, liters, price_per_liter, mileage, full_tank, station_name, comments)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
            [car_id, amount, liters, ppl, mileage, full_tank ? 1 : 0, station_name, comments]
        );

        // Обновляем пробег автомобиля
        await pool.query(
            `UPDATE cars SET mileage = GREATEST(mileage, $1) WHERE id = $2`,
            [mileage, car_id]
        );

        res.json(result.rows[0]);
    } catch (e) {
        console.error('Ошибка:', e.message);
        res.status(500).json({ error: 'Ошибка при добавлении' });
    }
});

// Добавить расход
app.post('/add-expense', validateTelegramId, async (req, res) => {
    try {
        const { car_id, category, amount, mileage, comments, user_id } = req.body;

        // Проверяем, что машина принадлежит пользователю
        const carCheck = await pool.query('SELECT id FROM cars WHERE id = $1 AND user_id = $2', [car_id, user_id]);
        if (carCheck.rowCount === 0) {
            return res.status(403).json({ error: 'Доступ запрещен' });
        }

        const result = await pool.query(
            `INSERT INTO car_expenses (car_id, category, amount, mileage, comments)
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [car_id, category, amount, mileage, comments]
        );

        res.json(result.rows[0]);
    } catch (e) {
        console.error('Ошибка:', e.message);
        res.status(500).json({ error: 'Ошибка при добавлении' });
    }
});

// Статистика
app.get('/stats/:carId/:period', validateTelegramId, async (req, res) => {
    try {
        const { carId, period } = req.params;
        const userId = req.query.user_id;
        
        // Проверяем, что машина принадлежит пользователю
        const carCheck = await pool.query('SELECT id FROM cars WHERE id = $1 AND user_id = $2', [carId, userId]);
        if (carCheck.rowCount === 0) {
            return res.status(403).json({ error: 'Доступ запрещен' });
        }
        
        let where = 'WHERE car_id = $1';
        const params = [carId];

        if (period === 'month') where += ' AND date >= NOW() - INTERVAL \'1 month\'';
        if (period === 'year')  where += ' AND date >= NOW() - INTERVAL \'1 year\'';

        const expRes = await pool.query(
            `SELECT category, SUM(amount) AS total FROM car_expenses ${where} GROUP BY category`,
            params
        );

        const fuelRes = await pool.query(
            `SELECT '⛽ Заправка' AS category, SUM(amount) AS total FROM fuel_records ${where}`,
            params
        );

        const expenses = [...expRes.rows, ...fuelRes.rows].filter(r => r.total);
        res.json({ expenses });
    } catch (e) {
        console.error('Ошибка:', e.message);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Обновление заправки
app.put('/fuel-records/:id', validateTelegramId, async (req, res) => {
    try {
        const { id } = req.params;
        const { amount, liters, mileage, full_tank, station_name, comments, user_id } = req.body;
        
        // Проверяем, что запись принадлежит пользователю
        const existing = await pool.query(
            'SELECT fr.*, c.user_id FROM fuel_records fr JOIN cars c ON fr.car_id = c.id WHERE fr.id = $1',
            [id]
        );
        if (existing.rowCount === 0) return res.status(404).json({ error: 'Запись не найдена' });
        if (existing.rows[0].user_id !== user_id) {
            return res.status(403).json({ error: 'Доступ запрещен' });
        }

        const ppl = amount / liters;

        const result = await pool.query(
            `UPDATE fuel_records SET amount = $1, liters = $2, price_per_liter = $3, 
             mileage = $4, full_tank = $5, station_name = $6, comments = $7
             WHERE id = $8 RETURNING *`,
            [amount, liters, ppl, mileage, full_tank ? 1 : 0, station_name, comments, id]
        );

        res.json(result.rows[0]);
    } catch (e) {
        console.error('Ошибка:', e.message);
        res.status(500).json({ error: 'Ошибка при обновлении' });
    }
});

// Удаление заправки
app.delete('/fuel-records/:id', validateTelegramId, async (req, res) => {
    try {
        const { id } = req.params;
        const { user_id } = req.body;
        
        // Проверяем, что запись принадлежит пользователю
        const existing = await pool.query(
            'SELECT fr.*, c.user_id FROM fuel_records fr JOIN cars c ON fr.car_id = c.id WHERE fr.id = $1',
            [id]
        );
        if (existing.rowCount === 0) return res.status(404).json({ error: 'Запись не найдена' });
        if (existing.rows[0].user_id !== user_id) {
            return res.status(403).json({ error: 'Доступ запрещен' });
        }

        await pool.query('DELETE FROM fuel_records WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (e) {
        console.error('Ошибка:', e.message);
        res.status(500).json({ error: 'Ошибка при удалении' });
    }
});

// Обновление расхода
app.put('/car-expenses/:id', validateTelegramId, async (req, res) => {
    try {
        const { id } = req.params;
        const { category, amount, mileage, comments, user_id } = req.body;
        
        // Проверяем, что запись принадлежит пользователю
        const existing = await pool.query(
            'SELECT ce.*, c.user_id FROM car_expenses ce JOIN cars c ON ce.car_id = c.id WHERE ce.id = $1',
            [id]
        );
        if (existing.rowCount === 0) return res.status(404).json({ error: 'Запись не найдена' });
        if (existing.rows[0].user_id !== user_id) {
            return res.status(403).json({ error: 'Доступ запрещен' });
        }

        const result = await pool.query(
            `UPDATE car_expenses SET category = $1, amount = $2, mileage = $3, comments = $4
             WHERE id = $5 RETURNING *`,
            [category, amount, mileage, comments, id]
        );

        res.json(result.rows[0]);
    } catch (e) {
        console.error('Ошибка:', e.message);
        res.status(500).json({ error: 'Ошибка при обновлении' });
    }
});

// Удаление расхода
app.delete('/car-expenses/:id', validateTelegramId, async (req, res) => {
    try {
        const { id } = req.params;
        const { user_id } = req.body;
        
        // Проверяем, что запись принадлежит пользователю
        const existing = await pool.query(
            'SELECT ce.*, c.user_id FROM car_expenses ce JOIN cars c ON ce.car_id = c.id WHERE ce.id = $1',
            [id]
        );
        if (existing.rowCount === 0) return res.status(404).json({ error: 'Запись не найдена' });
        if (existing.rows[0].user_id !== user_id) {
            return res.status(403).json({ error: 'Доступ запрещен' });
        }

        await pool.query('DELETE FROM car_expenses WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (e) {
        console.error('Ошибка:', e.message);
        res.status(500).json({ error: 'Ошибка при удалении' });
    }
});

// Проверка здоровья
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
});