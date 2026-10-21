-- phpMyAdmin SQL Dump
-- version 5.2.1
-- https://www.phpmyadmin.net/
--
-- Host: localhost
-- Generation Time: Jun 10, 2024 at 02:39 PM
-- Server version: 10.4.28-MariaDB
-- PHP Version: 8.0.28

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";


/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;

--
-- Database: `sockets`
--

-- --------------------------------------------------------

--
-- Table structure for table `chat`
--

CREATE TABLE `chat` (
  `id` int(11) NOT NULL,
  `is_chat` text DEFAULT NULL,
  `from_id` int(11) DEFAULT NULL,
  `to_id` int(11) DEFAULT NULL,
  `message` longtext DEFAULT NULL,
  `is_read` int(11) DEFAULT NULL,
  `created_time` text DEFAULT NULL,
  `messageType` longtext DEFAULT NULL,
  `attachment` longtext DEFAULT NULL,
  `type` text DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `chat`
--

INSERT INTO `chat` (`id`, `is_chat`, `from_id`, `to_id`, `message`, `is_read`, `created_time`, `messageType`, `attachment`, `type`) VALUES
(20, '1', 1467, 1516, 'hi', 1, '2024-05-28T11:47:24.818Z', 'TextMessage', NULL, 'TextMessage'),
(21, '1', 1467, 1516, 'bye', 1, '2024-05-28T11:47:46.046Z', 'TextMessage', NULL, 'TextMessage');

-- --------------------------------------------------------

--
-- Table structure for table `logs_sockets`
--

CREATE TABLE `logs_sockets` (
  `id` int(11) NOT NULL,
  `app_name` text NOT NULL,
  `socket_name` varchar(250) NOT NULL,
  `error` longtext NOT NULL,
  `datetime` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `logs_sockets`
--

INSERT INTO `logs_sockets` (`id`, `app_name`, `socket_name`, `error`, `datetime`) VALUES
(1, '', '1', 'Exception error Error: insert into `logs_sockets` (`error`, `socket_name`) values (DEFAULT, \'1\') - ER_NO_DEFAULT_FOR_FIELD: Field \'error\' doesn\'t have a default value', '2023-12-21 07:05:45'),
(2, '', '1', 'a', '2023-12-21 07:07:45'),
(3, 'telemedicine', '1', 'a', '2023-12-21 07:16:13');

-- --------------------------------------------------------

--
-- Table structure for table `profile`
--

CREATE TABLE `profile` (
  `id` int(11) NOT NULL,
  `user_id` int(11) NOT NULL,
  `first_name` text NOT NULL,
  `last_name` text NOT NULL,
  `email` text NOT NULL,
  `image` text DEFAULT NULL,
  `token` text DEFAULT NULL,
  `role` varchar(11) DEFAULT NULL,
  `status` varchar(50) DEFAULT NULL,
  `socket_id` varchar(200) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `profile`
--

INSERT INTO `profile` (`id`, `user_id`, `first_name`, `last_name`, `email`, `image`, `token`, `role`, `status`, `socket_id`) VALUES
(6, 1, 'John', 'Doe', 'john.doe@example.com', 'john_profile.jpg', 'user_token_value', '101', 'isDeactive', 'uTp5aNwB-KAlFO3xAAAF'),
(7, 101, 'Dr. Sarah', 'Smith', 'sarah.smith@example.com', 'sarah_profile.jpg', 'doctor_token_value', '201', 'isActive', 'WEPJSCCtp26JgJ-jAAAF'),
(9, 12, 'fawad', 'ali', 'fawad1824@gmail.com', NULL, 'token', 'admin', 'isActive', NULL),
(10, 12, 'fawad', 'ali', 'fawad1s824@gmail.com', NULL, 'token', 'admin', 'isActive', NULL),
(11, 1467, 'NIGERIAN', 'PROUD', 'nn@yopmail.com', NULL, 'cyHGki-8RkCf6iTstsRChd:APA91bEX8vAnxB8mTL0WknbvfC0ERhVBkyY_m-tXgThbSe8i8-1A69zBIqmVqwIBqQZX3sycHrb1hnjzoLnjo0-IZ71oR9KYOC1YlFh88WbixSR0XkYTbcnchmdoj8JcAFC-5TMWPe8i', 'user', 'isDeactive', '4Psfpysvnuv3x8d1AAAF'),
(12, 1472, 'doctor', 'ali', 'doctor@gmail.com', NULL, 'ca1m5wdtS6mZAuWJIyWxwp:APA91bFd5SzPgIrR-_AOqGpx25pIcSuodg_gtxmNABj29kaabGh98yYiR8IkJIHOIBRcSZPGAmz3NIrR90Xtusosf4mGk6R9rhHmFHVpSKJbeQI5ZV3_-euEitJ-cLBY8uyVDw7fPAlL', 'user', 'isDeactive', '4m50WbDwBPnetOALAAAH'),
(13, 1516, 'Hasley', 'David', 'hasley.david@gamil.com', NULL, 'coPf8tIlSjehvmvXDY6sJR:APA91bFcUIyA--u1jxyO56nauymn8k3JML0zevTNS9ufN7phUn3nESe1PyMvxd0xCyLj-38uafIxLab5G88kblqQJ1ZsNmbXdL2UhkBHeWuC9wICikCqANTnNh874_mIt6yyfoCn-voT', 'user', 'isDeactive', 'Y3HDlfyGShdy7HE1AAAB'),
(14, 30, 'CHARLES', 'SANDAWARE', 'alpha24@yopmail.com', NULL, 'cyHGki-8RkCf6iTstsRChd:APA91bEX8vAnxB8mTL0WknbvfC0ERhVBkyY_m-tXgThbSe8i8-1A69zBIqmVqwIBqQZX3sycHrb1hnjzoLnjo0-IZ71oR9KYOC1YlFh88WbixSR0XkYTbcnchmdoj8JcAFC-5TMWPe8i', 'user', 'isDeactive', '0llVuLBsi4J0RW_IAAAJ');

-- --------------------------------------------------------

--
-- Table structure for table `rooms`
--

CREATE TABLE `rooms` (
  `id` int(11) NOT NULL,
  `name` text NOT NULL,
  `staff_id` int(11) NOT NULL,
  `appoint_id` int(11) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `rooms`
--

INSERT INTO `rooms` (`id`, `name`, `staff_id`, `appoint_id`) VALUES
(26, 'Room-1-101-1001', 101, 1001),
(27, 'Room-1467-1472-34', 1472, 34),
(28, 'Room-1467-1472-35', 1472, 35),
(29, 'Room-1467-1516-58', 1516, 58);

-- --------------------------------------------------------

--
-- Table structure for table `room_detail`
--

CREATE TABLE `room_detail` (
  `id` int(11) NOT NULL,
  `room_id` int(11) NOT NULL,
  `user_id` int(11) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `room_detail`
--

INSERT INTO `room_detail` (`id`, `room_id`, `user_id`) VALUES
(8, 24, 1),
(9, 24, 101),
(10, 26, 1),
(11, 26, 101),
(12, 24, 1),
(13, 24, 101),
(14, 24, 1),
(15, 24, 101),
(16, 26, 1),
(17, 26, 101),
(18, 26, 1),
(19, 26, 101),
(20, 27, 1467),
(21, 27, 1472),
(22, 28, 1467),
(23, 28, 1472),
(24, 29, 1467),
(25, 29, 1516);

--
-- Indexes for dumped tables
--

--
-- Indexes for table `chat`
--
ALTER TABLE `chat`
  ADD PRIMARY KEY (`id`);

--
-- Indexes for table `logs_sockets`
--
ALTER TABLE `logs_sockets`
  ADD PRIMARY KEY (`id`);

--
-- Indexes for table `profile`
--
ALTER TABLE `profile`
  ADD PRIMARY KEY (`id`);

--
-- Indexes for table `rooms`
--
ALTER TABLE `rooms`
  ADD PRIMARY KEY (`id`);

--
-- Indexes for table `room_detail`
--
ALTER TABLE `room_detail`
  ADD PRIMARY KEY (`id`);

--
-- AUTO_INCREMENT for dumped tables
--

--
-- AUTO_INCREMENT for table `chat`
--
ALTER TABLE `chat`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=22;

--
-- AUTO_INCREMENT for table `logs_sockets`
--
ALTER TABLE `logs_sockets`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=4;

--
-- AUTO_INCREMENT for table `profile`
--
ALTER TABLE `profile`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=15;

--
-- AUTO_INCREMENT for table `rooms`
--
ALTER TABLE `rooms`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=30;

--
-- AUTO_INCREMENT for table `room_detail`
--
ALTER TABLE `room_detail`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=26;
COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
