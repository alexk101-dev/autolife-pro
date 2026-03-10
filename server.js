const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Подключение к PostgreSQL (Supabase)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' 
    ? { rejectUnauthorized: false } 
    : false,
});

// Проверка соединения при старте
pool.connect()
  .then(() => console.log('→ PostgreSQL (Supabase) подключён успешно'))
  .catch(err => {
    console.error('Ошибка подключения к PostgreSQL:', err.message);
    process.exit(1);
  });

// Инициализация таблиц (идемпотентно)
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS expenses (
        id          SERIAL PRIMARY KEY,
        title       TEXT NOT NULL,
        amount      REAL NOT NULL,
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS cars (
        id                  SERIAL PRIMARY KEY,
        user_id             TEXT NOT NULL,
        car_name            TEXT NOT NULL,
        reg_number          TEXT,
        mileage             INTEGER DEFAULT 0,
        oil_change_interval INTEGER DEFAULT 10000,
        created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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

    // Проверяем и добавляем колонку mileage только если её нет
    const colCheck = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'car_expenses' AND column_name = 'mileage'
    `);

    if (colCheck.rowCount === 0) {
      await pool.query('ALTER TABLE car_expenses ADD COLUMN mileage INTEGER');
      console.log('Колонка mileage добавлена в car_expenses');
    } else {
      console.log('Колонка mileage уже существует — пропускаем');
    }

    console.log('✅ Все таблицы проверены и готовы');
  } catch (err) {
    console.error('Ошибка инициализации базы:', err.message);
  }
}

initDB().catch(console.error);

// Health-check для Render и Telegram
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', env: process.env.NODE_ENV || 'development' });
});

// ─── АДАПТИРОВАННЫЕ МАРШРУТЫ ────────────────────────────────────────

app.get('/api/expenses', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM expenses ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (e) {
    console.error('GET /api/expenses:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/expenses', async (req, res) => {
  try {
    const { title, amount } = req.body;
    if (!title || !amount) return res.status(400).json({ error: 'title и amount обязательны' });
    
    const result = await pool.query(
      'INSERT INTO expenses (title, amount) VALUES ($1, $2) RETURNING *',
      [title, amount]
    );
    res.json(result.rows[0]);
  } catch (e) {
    console.error('POST /api/expenses:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/expenses/:id', async (req, res) => {
  try {
    const { title, amount } = req.body;
    const result = await pool.query(
      'UPDATE expenses SET title = $1, amount = $2 WHERE id = $3 RETURNING *',
      [title, amount, req.params.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Запись не найдена' });
    res.json(result.rows[0]);
  } catch (e) {
    console.error('PUT /api/expenses:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/expenses/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM expenses WHERE id = $1', [req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Запись не найдена' });
    res.json({ success: true });
  } catch (e) {
    console.error('DELETE /api/expenses:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── API ДЛЯ АВТО ───────────────────────────────────────────────────

app.get('/cars/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const result = await pool.query(
      'SELECT * FROM cars WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    );
    res.json(result.rows);
  } catch (e) {
    console.error('GET /cars:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/add-car', async (req, res) => {
  try {
    const { user_id, car_name, reg_number, mileage = 0 } = req.body;
    if (!user_id || !car_name) {
      return res.status(400).json({ error: 'user_id и car_name обязательны' });
    }
    const result = await pool.query(
      `INSERT INTO cars (user_id, car_name, reg_number, mileage)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [user_id, car_name, reg_number || null, Number(mileage)]
    );
    res.json(result.rows[0]);
  } catch (e) {
    console.error('POST /add-car:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/update-car/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { car_name, reg_number, mileage, oil_change_interval } = req.body;
    const result = await pool.query(
      `UPDATE cars
       SET car_name = $1, reg_number = $2, mileage = $3, oil_change_interval = $4
       WHERE id = $5 RETURNING *`,
      [
        car_name,
        reg_number || null,
        Number(mileage) || 0,
        Number(oil_change_interval) || 10000,
        id
      ]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Авто не найдено' });
    res.json(result.rows[0]);
  } catch (e) {
    console.error('PUT /update-car:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/cars/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM fuel_records WHERE car_id = $1', [id]);
    await pool.query('DELETE FROM car_expenses WHERE car_id = $1', [id]);
    const result = await pool.query('DELETE FROM cars WHERE id = $1', [id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Авто не найдено' });
    res.json({ success: true });
  } catch (e) {
    console.error('DELETE /cars:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── ДАШБОРД ────────────────────────────────────────────────────────

app.get('/dashboard/:carId', async (req, res) => {
  try {
    const { carId } = req.params;
    const carRes = await pool.query('SELECT * FROM cars WHERE id = $1', [carId]);
    const car = carRes.rows[0];
    if (!car) return res.status(404).json({ error: 'Авто не найдено' });

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

    res.json({ car, history });
  } catch (e) {
    console.error('GET /dashboard:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── ЗАПРАВКА ───────────────────────────────────────────────────────

app.post('/add-fuel', async (req, res) => {
  try {
    const { car_id, amount, liters, price_per_liter, mileage, full_tank, station_name, comments } = req.body;
    if (!car_id || !amount || !liters || !mileage) {
      return res.status(400).json({ error: 'Обязательные поля: car_id, amount, liters, mileage' });
    }

    const ppl = price_per_liter || (amount / liters);

    const result = await pool.query(
      `INSERT INTO fuel_records (car_id, amount, liters, price_per_liter, mileage, full_tank, station_name, comments)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [car_id, amount, liters, ppl, mileage, full_tank ? 1 : 0, station_name || null, comments || null]
    );

    await pool.query(
      `UPDATE cars SET mileage = GREATEST(mileage, $1) WHERE id = $2`,
      [mileage, car_id]
    );

    res.json(result.rows[0]);
  } catch (e) {
    console.error('POST /add-fuel:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── ОСТАЛЬНЫЕ МАРШРУТЫ (аналогично адаптированы) ──────────────────

app.post('/add-expense', async (req, res) => {
  try {
    const { car_id, category, amount, mileage, comments } = req.body;
    if (!car_id || !category || !amount) {
      return res.status(400).json({ error: 'Обязательные поля: car_id, category, amount' });
    }

    const result = await pool.query(
      `INSERT INTO car_expenses (car_id, category, amount, mileage, comments)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [car_id, category, amount, mileage || null, comments || null]
    );

    res.json(result.rows[0]);
  } catch (e) {
    console.error('POST /add-expense:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/stats/:carId/:period', async (req, res) => {
  try {
    const { carId, period } = req.params;
    let where = 'WHERE car_id = $1';
    const params = [carId];

    if (period === 'month') where += ' AND date >= NOW() - INTERVAL \'1 month\'';
    if (period === 'year')  where += ' AND date >= NOW() - INTERVAL \'1 year\'';

    const expRes = await pool.query(
      `SELECT category, SUM(amount) AS total FROM car_expenses ${where} GROUP BY category`,
      params
    );

    const fuelRes = await pool.query(
      `SELECT '⛽ Заправка' AS category, SUM(amount) AS total FROM fuel_records ${where} GROUP BY category`,
      params
    );

    const expenses = [...expRes.rows, ...fuelRes.rows].filter(r => r.total);
    res.json({ expenses });
  } catch (e) {
    console.error('GET /stats:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── UPDATE / DELETE ЗАПРАВОК И РАСХОДОВ ────────────────────────────

app.put('/fuel-records/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await pool.query('SELECT * FROM fuel_records WHERE id = $1', [id]);
    if (existing.rowCount === 0) return res.status(404).json({ error: 'Запись не найдена' });

    const row = existing.rows[0];
    const { amount = row.amount, liters = row.liters, mileage = row.mileage,
            full_tank = row.full_tank, station_name = row.station_name,
            comments = row.comments, price_per_liter } = req.body;

    const ppl = price_per_liter || (amount && liters ? amount / liters : row.price_per_liter);

    const result = await pool.query(
      `UPDATE fuel_records SET amount = $1, liters = $2, price_per_liter = $3, 
       mileage = $4, full_tank = $5, station_name = $6, comments = $7
       WHERE id = $8 RETURNING *`,
      [amount, liters, ppl, mileage, full_tank ? 1 : 0, station_name || null, comments || null, id]
    );

    await pool.query('UPDATE cars SET mileage = GREATEST(mileage, $1) WHERE id = $2',
      [mileage, row.car_id]);

    res.json(result.rows[0]);
  } catch (e) {
    console.error('PUT /fuel-records:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/fuel-records/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM fuel_records WHERE id = $1', [id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Запись не найдена' });
    res.json({ success: true });
  } catch (e) {
    console.error('DELETE /fuel-records:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/car-expenses/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await pool.query('SELECT * FROM car_expenses WHERE id = $1', [id]);
    if (existing.rowCount === 0) return res.status(404).json({ error: 'Запись не найдена' });

    const row = existing.rows[0];
    const { category = row.category, amount = row.amount, mileage = row.mileage,
            comments = row.comments } = req.body;

    const result = await pool.query(
      `UPDATE car_expenses SET category = $1, amount = $2, mileage = $3, comments = $4
       WHERE id = $5 RETURNING *`,
      [category, amount, mileage || null, comments || null, id]
    );

    res.json(result.rows[0]);
  } catch (e) {
    console.error('PUT /car-expenses:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/car-expenses/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM car_expenses WHERE id = $1', [id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Запись не найдена' });
    res.json({ success: true });
  } catch (e) {
    console.error('DELETE /car-expenses:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Запуск сервера (Render сам подставит PORT)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT} (Render/Supabase mode)`);
});