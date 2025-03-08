const WebSocket = require('ws');
const http = require('http');

// إنشاء خادم HTTP
const server = http.createServer((req, res) => {
  // إضافة نقطة فحص الصحة
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'OK', time: new Date().toISOString() }));
    return;
  }
  
  res.writeHead(404);
  res.end();
});

// إنشاء خادم WebSocket باستخدام خادم HTTP
const wss = new WebSocket.Server({ server });
console.log('Servidor de señalización ejecutándose');

// Almacenar usuarios y salas
const rooms = {};

// Función para enviar mensaje con manejo de errores
function sendMessage(ws, message) {
  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
      return true;
    } else {
      console.log('Socket no está abierto. Estado actual:', ws.readyState);
      return false;
    }
  } catch (e) {
    console.error('Error enviando mensaje:', e);
    return false;
  }
}

wss.on('connection', (ws) => {
  console.log('Nueva conexión establecida');
  
  // Configurar un ping periódico para mantener la conexión viva
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    } else {
      clearInterval(pingInterval);
    }
  }, 30000);
  
  // Manejador de mensajes recibidos
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      console.log(`Mensaje recibido: ${data.type}${data.target ? `, para: ${data.target}` : ''}`);
      
      // Manejar unión a sala
      if (data.type === 'join') {
        const { roomId, userId, isTeacher } = data;
        console.log(`Usuario ${userId} solicitando unirse a sala ${roomId}`);
        
        // Crear sala si no existe
        if (!rooms[roomId]) {
          console.log(`Creando nueva sala: ${roomId}`);
          rooms[roomId] = {};
        }
        
        // Guardar información del usuario
        rooms[roomId][userId] = ws;
        ws.roomId = roomId;
        ws.userId = userId;
        ws.isTeacher = !!isTeacher;
        
        // Enviar lista de usuarios actuales al nuevo usuario
        const usersInRoom = Object.keys(rooms[roomId]).filter(id => id !== userId);
        console.log(`Usuarios existentes en sala ${roomId}:`, usersInRoom);
        
        sendMessage(ws, {
          type: 'room_users',
          users: usersInRoom
        });
        
        // Notificar a otros usuarios sobre el nuevo usuario
        usersInRoom.forEach(id => {
          console.log(`Notificando a ${id} sobre la unión de ${userId}`);
          const otherWs = rooms[roomId][id];
          sendMessage(otherWs, {
            type: 'user_joined',
            userId: userId
          });
        });
        
        console.log(`Usuario ${userId} se unió a la sala ${roomId}`);
      }
      
      // Reenviar mensajes (ofertas, respuestas, candidatos ICE)
      else if (data.target) {
        const { roomId } = ws;
        const { target } = data;
        
        if (roomId && rooms[roomId] && rooms[roomId][target]) {
          // Añadir ID del remitente al mensaje
          data.sender = ws.userId;
          
          // Enviar mensaje al usuario objetivo
          console.log(`Reenviando mensaje ${data.type} de ${ws.userId} a ${target}`);
          const targetWs = rooms[roomId][target];
          
          if (!sendMessage(targetWs, data)) {
            console.log(`No se pudo enviar mensaje a ${target} - Limpiando conexión`);
            handleLeave(targetWs);
          }
        } else {
          console.log(`Error: No se puede enviar mensaje a ${target} - Usuario no encontrado o sala incorrecta`);
          // Informar al remitente que el destinatario no se encontró
          sendMessage(ws, {
            type: 'error',
            message: `Usuario ${target} no encontrado en la sala`
          });
        }
      }
      
      // Manejar silencio forzado
      else if (data.type === 'mute_participant') {
        const { roomId } = ws;
        const { target, mute } = data;
        
        // Verificar permisos para silenciar
        if (!ws.isTeacher && ws.userId !== target) {
          console.log(`Usuario ${ws.userId} no tiene permisos para silenciar a ${target}`);
          return;
        }
        
        if (roomId && rooms[roomId] && rooms[roomId][target]) {
          console.log(`${ws.isTeacher ? 'Profesor' : 'Usuario'} ${ws.userId} ${mute ? 'silenciando' : 'activando audio de'} ${target}`);
          
          // Enviar mensaje al usuario objetivo
          const targetWs = rooms[roomId][target];
          sendMessage(targetWs, {
            type: 'mute_participant',
            target: target,
            mute: mute
          });
          
          // Notificar a todos los demás usuarios sobre el cambio de estado
          Object.keys(rooms[roomId]).forEach(userId => {
            if (userId !== ws.userId && userId !== target) {
              sendMessage(rooms[roomId][userId], {
                type: 'participant_muted',
                userId: target,
                muted: mute
              });
            }
          });
        }
      }
      
      // Manejar expulsión de participante
      else if (data.type === 'remove_participant') {
        const { roomId } = ws;
        const { target } = data;
        
        // Verificar que solo un profesor puede expulsar
        if (!ws.isTeacher) {
          console.log(`Usuario no profesor ${ws.userId} intentó expulsar a ${target}`);
          return;
        }
        
        if (roomId && rooms[roomId] && rooms[roomId][target]) {
          console.log(`Profesor ${ws.userId} expulsando a ${target}`);
          
          // Enviar mensaje al usuario objetivo
          const targetWs = rooms[roomId][target];
          sendMessage(targetWs, {
            type: 'remove_participant',
            target: target
          });
          
          // Notificar a todos los demás usuarios
          Object.keys(rooms[roomId]).forEach(userId => {
            if (userId !== ws.userId && userId !== target) {
              sendMessage(rooms[roomId][userId], {
                type: 'participant_removed',
                userId: target
              });
            }
          });
          
          // Limpiar la conexión del usuario expulsado
          handleLeave(targetWs);
        }
      }
      
      // Manejar cambio de modo prueba
      else if (data.type === 'test_mode_changed') {
        const { roomId } = ws;
        const { isTestMode, studentId } = data;
        
        // Verificar que solo un profesor puede cambiar el modo
        if (!ws.isTeacher) {
          console.log(`Usuario no profesor ${ws.userId} intentó cambiar modo prueba`);
          return;
        }
        
        if (roomId && rooms[roomId]) {
          console.log(`Profesor ${ws.userId} ${isTestMode ? 'iniciando' : 'finalizando'} modo prueba ${studentId ? `con estudiante ${studentId}` : ''}`);
          
          // Notificar a todos los participantes
          Object.keys(rooms[roomId]).forEach(userId => {
            if (userId !== ws.userId) {
              sendMessage(rooms[roomId][userId], {
                type: 'test_mode_changed',
                isTestMode: isTestMode,
                studentId: studentId
              });
            }
          });
        }
      }
      
      // Manejar salida de sala
      else if (data.type === 'leave') {
        console.log(`Usuario ${ws.userId} solicitando salir de sala ${ws.roomId}`);
        handleLeave(ws);
      }
      
      // Manejar finalización de llamada
      else if (data.type === 'call_ended') {
        const { roomId } = data;
        console.log(`Usuario ${ws.userId} finalizando llamada en sala ${roomId}`);
        
        if (roomId && rooms[roomId]) {
          // Enviar notificación de fin de llamada a todos los usuarios en la sala
          Object.keys(rooms[roomId]).forEach(userId => {
            if (userId !== ws.userId) {
              console.log(`Notificando a ${userId} sobre el fin de la llamada`);
              const otherWs = rooms[roomId][userId];
              sendMessage(otherWs, {
                type: 'call_ended'
              });
            }
          });
        }
      }
    } catch (e) {
      console.error('Error al procesar mensaje:', e);
    }
  });
  
  // Manejar pings para mantener la conexión viva
  ws.on('pong', () => {
    ws.isAlive = true;
  });
  
  // Manejar desconexión
  ws.on('close', () => {
    console.log(`Conexión cerrada para usuario ${ws.userId || 'desconocido'}`);
    clearInterval(pingInterval);
    handleLeave(ws);
  });
  
  // Manejar errores
  ws.on('error', (error) => {
    console.error(`Error en la conexión para usuario ${ws.userId || 'desconocido'}:`, error);
    clearInterval(pingInterval);
    handleLeave(ws);
  });
  
  // Función para manejar salida
  function handleLeave(ws) {
    const { roomId, userId } = ws;
    
    if (roomId && userId && rooms[roomId] && rooms[roomId][userId]) {
      // Eliminar usuario de la sala
      delete rooms[roomId][userId];
      console.log(`Usuario ${userId} eliminado de la sala ${roomId}`);
      
      // Notificar a otros usuarios sobre la salida
      Object.keys(rooms[roomId]).forEach(id => {
        console.log(`Notificando a ${id} sobre la salida de ${userId}`);
        const otherWs = rooms[roomId][id];
        sendMessage(otherWs, {
          type: 'user_left',
          userId: userId
        });
      });
      
      // Eliminar sala si está vacía
      if (Object.keys(rooms[roomId]).length === 0) {
        console.log(`Sala ${roomId} vacía - eliminando`);
        delete rooms[roomId];
      }
      
      console.log(`Usuario ${userId} abandonó la sala ${roomId}`);
    }
  }
});

// Verificación periódica de conexiones muertas
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log('Eliminando conexión muerta');
      return ws.terminate();
    }
    
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => {
  clearInterval(interval);
});

// Imprimir estadísticas periódicas
setInterval(() => {
  const numRooms = Object.keys(rooms).length;
  let totalUsers = 0;
  Object.keys(rooms).forEach(roomId => {
    const numUsers = Object.keys(rooms[roomId]).length;
    totalUsers += numUsers;
    console.log(`Sala ${roomId}: ${numUsers} usuarios`);
  });
  console.log(`Total: ${numRooms} salas, ${totalUsers} usuarios conectados`);
}, 60000);

// Usar puerto de las variables de entorno (importante para Render.com)
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Servidor de señalización ejecutándose en el puerto ${PORT}`);
  console.log(`Servidor de señalización listo para aceptar conexiones en el puerto ${PORT}`);
});