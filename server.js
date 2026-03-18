const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');

const app = express();

// Базовые middleware безопасности
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://telegram.org"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            imgSrc: ["'self'", "data:", "https:"],
            connectSrc: ["'self'"]
        }
    }
}));

// CORS с ограничениями
app.use(cors({
    origin: process.env.NODE_ENV === 'production' 
        ? [process.env.RENDER_EXTERNAL_URL || 'https://autolife-pro.onrender.com', 'https://t.me'] 
        : '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Telegram-Init-Data']
}));

// Парсинг JSON с ограничением размера
app.use(express.json({ limit: '10kb' }));

// Rate limiting
const apiLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 минута
    max: 30, // максимум 30 запросов в минуту
    message: { error: 'Слишком много запросов, попробуйте позже' },
    standardHeaders: true,
    legacyHeaders: false,
});

// Применяем rate limiting ко всем API маршрутам
app.use('/api/', apiLimiter);
app.use('/add-car', apiLimiter);
app.use('/add-fuel', apiLimiter);
app.use('/add-expense', apiLimiter);

// Подключение к базе
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // для Render PostgreSQL
    },
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

pool.connect()
    .then(() => console.log('→ PostgreSQL подключён успешно'))
    .catch(err => {
        console.error('Ошибка подключения к PostgreSQL:', err.message);
        process.exit(1);
    });

// Инициализация таблиц
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

            CREATE TABLE IF NOT EXISTS audit_log (
                id SERIAL PRIMARY KEY,
                user_id TEXT NOT NULL,
                action TEXT NOT NULL,
                target_id INTEGER,
                ip_address TEXT,
                user_agent TEXT,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Проверяем и добавляем колонку mileage если её нет
        const colCheck = await pool.query(`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name = 'car_expenses' AND column_name = 'mileage'
        `);

        if (colCheck.rowCount === 0) {
            await pool.query('ALTER TABLE car_expenses ADD COLUMN mileage INTEGER');
            console.log('Колонка mileage добавлена в car_expenses');
        }

        console.log('✅ База готова');
    } catch (err) {
        console.error('Ошибка инициализации базы:', err.message);
    }
}

initDB().catch(console.error);

// Функция для логирования аудита
async function logAudit(userId, action, targetId, req) {
    try {
        await pool.query(
            `INSERT INTO audit_log (user_id, action, target_id, ip_address, user_agent, timestamp)
             VALUES ($1, $2, $3, $4, $5, NOW())`,
            [userId, action, targetId, req.ip, req.get('User-Agent')]
        );
    } catch (error) {
        console.error('Audit log error:', error);
    }
}

// Проверка Telegram данных
function verifyTelegramInitData(initData) {
    try {
        if (!initData) return false;
        
        const params = new URLSearchParams(initData);
        const hash = params.get('hash');
        
        if (!hash) return false;
        
        const dataToCheck = [];
        params.sort();
        params.forEach((value, key) => {
            if (key !== 'hash') {
                dataToCheck.push(`${key}=${value}`);
            }
        });
        
        // В продакшене токен должен быть в переменных окружения
        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        if (!botToken) {
            console.log('⚠️ TELEGRAM_BOT_TOKEN не установлен - пропускаем проверку');
            return true; // Временно пропускаем проверку для отладки
        }
        
        const secret = crypto.createHmac('sha256', 'WebAppData')
            .update(botToken);
        const calculatedHash = crypto.createHmac('sha256', secret.digest())
            .update(dataToCheck.join('\n'))
            .digest('hex');
        
        return calculatedHash === hash;
    } catch (error) {
        console.error('Telegram verification error:', error);
        return false;
    }
}

// Middleware для проверки авторизации (упрощенная версия для отладки)
async function authMiddleware(req, res, next) {
    const userId = req.params.userId || req.body.user_id || req.query.user_id;
    
    console.log(`[Auth] Запрос от userId: ${userId}`);
    console.log(`[Auth] Headers:`, req.headers);
    
    // Временно пропускаем все запросы для отладки
    if (userId) {
        console.log(`[Auth] Разрешаем доступ для: ${userId}`);
        return next();
    }
    
    return res.status(401).json({ error: 'Требуется авторизация' });
}

// Health-check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', env: process.env.NODE_ENV || 'development' });
});

// Список автомобилей пользователя
app.get('/cars/:userId', authMiddleware, async (req, res) => {
    const { userId } = req.params;
    console.log(`[API] GET /cars/${userId}`);
    
    try {
        const result = await pool.query(
            'SELECT id, car_name, reg_number, mileage, mileage_last_oil_change, oil_change_interval FROM cars WHERE user_id = $1 ORDER BY created_at DESC',
            [userId]
        );
        
        console.log(`[API] Найдено автомобилей: ${result.rows.length} для пользователя ${userId}`);
        res.json(result.rows);
    } catch (e) {
        console.error(`[API] Ошибка в /cars/${userId}:`, e.message);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Добавление автомобиля
app.post('/add-car', 
    authMiddleware,
    [
        body('car_name').trim().isLength({ min: 2, max: 50 }).escape(),
        body('reg_number').optional().trim().isLength({ max: 10 }).escape(),
        body('mileage').optional().isInt({ min: 0, max: 9999999 })
    ],
    async (req, res) => {
        // Проверка валидации
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }
        
        const { user_id, car_name, reg_number, mileage = 0 } = req.body;
        console.log(`[API] POST /add-car для пользователя ${user_id}:`, { car_name, reg_number, mileage });
        
        try {
            const result = await pool.query(
                `INSERT INTO cars (user_id, car_name, reg_number, mileage, mileage_last_oil_change, oil_change_interval)
                 VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, car_name, reg_number`,
                [user_id, car_name, reg_number || null, mileage, mileage, 10000]
            );
            
            await logAudit(user_id, 'CREATE_CAR', result.rows[0].id, req);
            
            console.log(`[API] Автомобиль добавлен с ID: ${result.rows[0].id}`);
            res.json(result.rows[0]);
        } catch (e) {
            console.error('[API] POST /add-car error:', e.message);
            res.status(500).json({ error: 'Ошибка при добавлении автомобиля' });
        }
    }
);

// Обновление настроек авто
app.put('/update-car/:id', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const { car_name, reg_number, mileage, mileage_last_oil_change, oil_change_interval, user_id } = req.body;

    try {
        const result = await pool.query(
            `UPDATE cars
             SET car_name = $1, reg_number = $2, mileage = $3, mileage_last_oil_change = $4, oil_change_interval = $5
             WHERE id = $6 AND user_id = $7 RETURNING *`,
            [
                car_name,
                reg_number || null,
                Number(mileage) || 0,
                Number(mileage_last_oil_change) || 0,
                Number(oil_change_interval) || 10000,
                id,
                user_id
            ]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Авто не найдено' });
        }

        await logAudit(user_id, 'UPDATE_CAR', id, req);
        res.json(result.rows[0]);
    } catch (e) {
        console.error(`PUT /update-car/${id} error:`, e.message);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Удаление авто
app.delete('/cars/:id', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const { user_id } = req.body;

    try {
        await pool.query('DELETE FROM fuel_records WHERE car_id = $1', [id]);
        await pool.query('DELETE FROM car_expenses WHERE car_id = $1', [id]);
        const result = await pool.query('DELETE FROM cars WHERE id = $1 AND user_id = $2', [id, user_id]);

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Авто не найдено' });
        }

        await logAudit(user_id, 'DELETE_CAR', id, req);
        res.json({ success: true });
    } catch (e) {
        console.error(`DELETE /cars/${id} error:`, e.message);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Дашборд
app.get('/dashboard/:carId', authMiddleware, async (req, res) => {
    const { carId } = req.params;
    const userId = req.query.user_id;

    try {
        const carRes = await pool.query('SELECT * FROM cars WHERE id = $1 AND user_id = $2', [carId, userId]);
        const car = carRes.rows[0];
        if (!car) {
            return res.status(404).json({ error: 'Авто не найдено' });
        }

        const lastOil = car.mileage_last_oil_change || 0;
        const interval = car.oil_change_interval || 10000;
        const current = car.mileage || 0;
        const driven = current - lastOil;
        const remaining = interval - driven;
        const percent = Math.min(Math.max((driven / interval) * 100, 0), 100);

        const fuelRes = await pool.query(
            `SELECT id, 'fuel' AS type, '⛽ Заправка' AS category, amount, liters, price_per_liter, 
                    mileage, full_tank, station_name, comments, date
             FROM fuel_records WHERE car_id = $1`,
            [carId]
        );

        const expRes = await pool.query(
            `SELECT id, 'expense' AS type, category, amount, NULL AS liters, NULL AS price_per_liter, 
                    mileage, comments, date
             FROM car_expenses WHERE car_id = $1`,
            [carId]
        );

        const history = [...fuelRes.rows, ...expRes.rows].sort(
            (a, b) => new Date(b.date) - new Date(a.date)
        );

        res.json({ 
            car: {
                ...car,
                oil_remaining: remaining > 0 ? remaining : 0,
                oil_percent: percent
            }, 
            history 
        });
    } catch (e) {
        console.error(`GET /dashboard/${carId} error:`, e.message);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Добавление заправки
app.post('/add-fuel', authMiddleware, async (req, res) => {
    try {
        const { car_id, amount, liters, mileage, full_tank, station_name, comments, user_id } = req.body;
        
        if (!car_id || !amount || !liters || !mileage) {
            return res.status(400).json({ error: 'Обязательные поля: car_id, amount, liters, mileage' });
        }

        // Проверяем права доступа к авто
        const carCheck = await pool.query('SELECT id FROM cars WHERE id = $1 AND user_id = $2', [car_id, user_id]);
        if (carCheck.rowCount === 0) {
            return res.status(403).json({ error: 'Доступ запрещен' });
        }

        const ppl = amount / liters;

        const result = await pool.query(
            `INSERT INTO fuel_records (car_id, amount, liters, price_per_liter, mileage, full_tank, station_name, comments)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
            [car_id, amount, liters, ppl, mileage, full_tank ? 1 : 0, station_name || null, comments || null]
        );

        await pool.query(
            `UPDATE cars SET mileage = GREATEST(mileage, $1) WHERE id = $2`,
            [mileage, car_id]
        );

        await logAudit(user_id, 'ADD_FUEL', result.rows[0].id, req);
        res.json(result.rows[0]);
    } catch (e) {
        console.error('POST /add-fuel:', e.message);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Добавление расхода
app.post('/add-expense', authMiddleware, async (req, res) => {
    try {
        const { car_id, category, amount, mileage, comments, user_id } = req.body;
        
        if (!car_id || !category || !amount) {
            return res.status(400).json({ error: 'Обязательные поля: car_id, category, amount' });
        }

        // Проверяем права доступа к авто
        const carCheck = await pool.query('SELECT id FROM cars WHERE id = $1 AND user_id = $2', [car_id, user_id]);
        if (carCheck.rowCount === 0) {
            return res.status(403).json({ error: 'Доступ запрещен' });
        }

        const result = await pool.query(
            `INSERT INTO car_expenses (car_id, category, amount, mileage, comments)
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [car_id, category, amount, mileage || null, comments || null]
        );

        await logAudit(user_id, 'ADD_EXPENSE', result.rows[0].id, req);
        res.json(result.rows[0]);
    } catch (e) {
        console.error('POST /add-expense:', e.message);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Статистика
app.get('/stats/:carId/:period', authMiddleware, async (req, res) => {
    try {
        const { carId, period } = req.params;
        const userId = req.query.user_id;
        
        // Проверяем права доступа к авто
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
        console.error('GET /stats:', e.message);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Обновление заправки
app.put('/fuel-records/:id', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { amount, liters, mileage, full_tank, station_name, comments, user_id } = req.body;
        
        // Проверяем права доступа
        const existing = await pool.query(
            'SELECT fr.*, c.user_id FROM fuel_records fr JOIN cars c ON fr.car_id = c.id WHERE fr.id = $1',
            [id]
        );
        if (existing.rowCount === 0) return res.status(404).json({ error: 'Запись не найдена' });
        if (existing.rows[0].user_id !== user_id) {
            return res.status(403).json({ error: 'Доступ запрещен' });
        }

        const row = existing.rows[0];
        const ppl = amount / liters;

        const result = await pool.query(
            `UPDATE fuel_records SET amount = $1, liters = $2, price_per_liter = $3, 
             mileage = $4, full_tank = $5, station_name = $6, comments = $7
             WHERE id = $8 RETURNING *`,
            [amount, liters, ppl, mileage, full_tank ? 1 : 0, station_name || null, comments || null, id]
        );

        await pool.query('UPDATE cars SET mileage = GREATEST(mileage, $1) WHERE id = $2',
            [mileage, row.car_id]);

        await logAudit(user_id, 'UPDATE_FUEL', id, req);
        res.json(result.rows[0]);
    } catch (e) {
        console.error('PUT /fuel-records:', e.message);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Удаление заправки
app.delete('/fuel-records/:id', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { user_id } = req.body;
        
        // Проверяем права доступа
        const existing = await pool.query(
            'SELECT fr.*, c.user_id FROM fuel_records fr JOIN cars c ON fr.car_id = c.id WHERE fr.id = $1',
            [id]
        );
        if (existing.rowCount === 0) return res.status(404).json({ error: 'Запись не найдена' });
        if (existing.rows[0].user_id !== user_id) {
            return res.status(403).json({ error: 'Доступ запрещен' });
        }

        const result = await pool.query('DELETE FROM fuel_records WHERE id = $1', [id]);
        await logAudit(user_id, 'DELETE_FUEL', id, req);
        res.json({ success: true });
    } catch (e) {
        console.error('DELETE /fuel-records:', e.message);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Обновление расхода
app.put('/car-expenses/:id', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { category, amount, mileage, comments, user_id } = req.body;
        
        // Проверяем права доступа
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
            [category, amount, mileage || null, comments || null, id]
        );

        await logAudit(user_id, 'UPDATE_EXPENSE', id, req);
        res.json(result.rows[0]);
    } catch (e) {
        console.error('PUT /car-expenses:', e.message);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Удаление расхода
app.delete('/car-expenses/:id', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { user_id } = req.body;
        
        // Проверяем права доступа
        const existing = await pool.query(
            'SELECT ce.*, c.user_id FROM car_expenses ce JOIN cars c ON ce.car_id = c.id WHERE ce.id = $1',
            [id]
        );
        if (existing.rowCount === 0) return res.status(404).json({ error: 'Запись не найдена' });
        if (existing.rows[0].user_id !== user_id) {
            return res.status(403).json({ error: 'Доступ запрещен' });
        }

        const result = await pool.query('DELETE FROM car_expenses WHERE id = $1', [id]);
        await logAudit(user_id, 'DELETE_EXPENSE', id, req);
        res.json({ success: true });
    } catch (e) {
        console.error('DELETE /car-expenses:', e.message);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Обработчик ошибок
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

// 404 обработчик
app.use((req, res) => {
    res.status(404).json({ error: 'Маршрут не найден' });
});

// ВАЖНО: Используем порт из переменной окружения Render
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
});