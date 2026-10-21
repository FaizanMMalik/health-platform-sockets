const socket = io('http://localhost:8006'); // Connect to the server

const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const startCallBtn = document.getElementById('startCall');
const endCallBtn = document.getElementById('endCall');

let localStream;
let peerConnection;

// STUN server configuration (you can use other public STUN servers)
const configuration = {
  iceServers: [
    {
      urls: 'stun:stun.l.google.com:19302', // Google's public STUN server
    },
  ],
};

// Get user media (camera and microphone)
navigator.mediaDevices.getUserMedia({ video: true, audio: true })
  .then(stream => {
    localStream = stream;
    localVideo.srcObject = stream;

    startCallBtn.disabled = false;
  })
  .catch(error => {
    console.error('Error accessing media devices:', error);
  });

// Event listeners for call control
startCallBtn.addEventListener('click', () => {
  startCall();
});

endCallBtn.addEventListener('click', () => {
  endCall();
});

// Function to start the call
function startCall() {
  peerConnection = new SimplePeer({ initiator: true, trickle: false, stream: localStream });

  // Event listeners for peerConnection
  peerConnection.on('signal', data => {
    socket.emit('offer', { targetUserId: 'TARGET_USER_ID', offerData: data });
  });

  peerConnection.on('stream', stream => {
    remoteVideo.srcObject = stream;
  });

  peerConnection.on('error', err => {
    console.error('Peer connection error:', err);
  });

  socket.on('answer', data => {
    peerConnection.signal(data.answerData);
  });

  socket.on('ice-candidate', data => {
    peerConnection.signal(data.iceCandidateData);
  });
}

// Function to end the call
function endCall() {
  if (peerConnection) {
    peerConnection.destroy();
    localVideo.srcObject = null;
    remoteVideo.srcObject = null;
  }
}
