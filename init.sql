ALTER USER 'root'@'%' IDENTIFIED WITH mysql_native_password BY 'rootpassword';
CREATE USER 'rootP'@'%' IDENTIFIED WITH mysql_native_password BY 'rootPpassword';
GRANT ALL PRIVILEGES ON sockets.* TO 'rootP'@'%';
FLUSH PRIVILEGES;