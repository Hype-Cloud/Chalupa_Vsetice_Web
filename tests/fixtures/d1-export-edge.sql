PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE kw (id INTEGER PRIMARY KEY, trigger TEXT, end TEXT, begin TEXT, temp TEXT, "create" TEXT);
INSERT INTO "kw" ("id","trigger","end","begin","temp","create") VALUES(1,'BEGIN','END;','CASE','x','CREATE TABLE z (a);');
INSERT INTO "kw" ("id","trigger","end","begin","temp","create") VALUES(2,'t','b','e','p','c');
CREATE TABLE notes (id INTEGER PRIMARY KEY, note TEXT NOT NULL, n INTEGER);
INSERT INTO "notes" ("id","note","n") VALUES(1,'radek CREATE TABLE phantom_ls (x);',1);
INSERT INTO "notes" ("id","note","n") VALUES(2,'odstavec CREATE VIEW phantom_ps AS SELECT 1;',2);
INSERT INTO "notes" ("id","note","n") VALUES(3,replace(replace('novy radek\nCREATE TABLE phantom_lf (x);\rCREATE INDEX phantom_cr ON notes(n);','\r',char(13)),'\n',char(10)),3);
INSERT INTO "notes" ("id","note","n") VALUES(4,'apostrof '' a strednik; -- ne komentar /* ani tento */',4);
CREATE TABLE audit (id INTEGER PRIMARY KEY, note_id INTEGER, kind TEXT);
CREATE INDEX notes_n ON notes(n);
CREATE TRIGGER notes_audit
AFTER UPDATE OF n ON notes
WHEN NEW.n IS NOT OLD.n
BEGIN
  INSERT INTO audit (note_id, kind) VALUES (NEW.id, CASE WHEN NEW.n > OLD.n THEN 'up' ELSE CASE WHEN NEW.n < OLD.n THEN 'down' ELSE 'same' END END);
  UPDATE kw SET begin = 'END; BEGIN' WHERE id = 2;
END;
CREATE VIEW notes_view AS SELECT id, note FROM notes WHERE note <> 'END;';