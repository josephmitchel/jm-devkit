CREATE TABLE visits (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  visited_at timestamptz NOT NULL DEFAULT now()
);
