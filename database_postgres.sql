-- ═══════════════════════════════════════════════════════════════
-- Esquema PostgreSQL — Bot WhatsApp Cabañas Guanaquero
-- ═══════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────
-- CABAÑAS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cabanas (
    id        SERIAL       PRIMARY KEY,
    nombre    VARCHAR(100) NOT NULL,
    capacidad INTEGER      NOT NULL DEFAULT 2,
    activa    BOOLEAN      NOT NULL DEFAULT TRUE,
    creado_en TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Datos iniciales: 7 cabañas estándar + 1 premium
INSERT INTO cabanas (nombre, capacidad, activa) VALUES
    ('Cabaña 1', 4, TRUE),
    ('Cabaña 2', 4, TRUE),
    ('Cabaña 3', 4, TRUE),
    ('Cabaña 4', 4, TRUE),
    ('Cabaña 5', 4, TRUE),
    ('Cabaña 6', 4, TRUE),
    ('Cabaña 7', 4, TRUE),
    ('Cabaña 8', 6, TRUE)   -- Premium: $100.000/noche
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────
-- RESERVAS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reservas (
    id             VARCHAR(20)  PRIMARY KEY,
    cabana_id      INTEGER      NOT NULL REFERENCES cabanas(id),
    check_in       DATE         NOT NULL,
    check_out      DATE         NOT NULL,
    nombre_huesped VARCHAR(150) NOT NULL,
    telefono       VARCHAR(50),
    whatsapp_jid   VARCHAR(100),
    personas       INTEGER      NOT NULL DEFAULT 1,
    notas          TEXT,
    origen         VARCHAR(30)  NOT NULL DEFAULT 'whatsapp',
    estado         VARCHAR(30)  NOT NULL DEFAULT 'pendiente',  -- pendiente | confirmada | cancelada
    creado_en      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    actualizado_en TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- SESIONES DEL BOT
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sesiones_bot (
    whatsapp_jid   VARCHAR(100) PRIMARY KEY,
    etapa          VARCHAR(50)  NOT NULL DEFAULT 'inicio',
    datos_temp     JSONB        NOT NULL DEFAULT '{}',
    reserva_id     VARCHAR(20)  REFERENCES reservas(id),
    creado_en      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    actualizado_en TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- HISTORIAL DE CONVERSACIONES
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS conversaciones_bot (
    id           BIGSERIAL    PRIMARY KEY,
    whatsapp_jid VARCHAR(100) NOT NULL,
    rol          VARCHAR(20)  NOT NULL CHECK (rol IN ('user', 'assistant')),
    mensaje      TEXT         NOT NULL,
    reserva_id   VARCHAR(20)  REFERENCES reservas(id),
    creado_en    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversaciones_jid_fecha
    ON conversaciones_bot (whatsapp_jid, creado_en DESC);

-- ─────────────────────────────────────────────
-- NOTIFICACIONES AL ADMINISTRADOR
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notificaciones_admin (
    id           BIGSERIAL    PRIMARY KEY,
    tipo         VARCHAR(50)  NOT NULL,
    reserva_id   VARCHAR(20)  REFERENCES reservas(id),
    whatsapp_jid VARCHAR(100),
    mensaje      TEXT         NOT NULL,
    resuelta     BOOLEAN      NOT NULL DEFAULT FALSE,
    creado_en    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

