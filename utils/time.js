export const formatMessageTimestamp = (date) => {
  const dt = new Date(date);
  const now = new Date();
  const diffMs = now - dt;
  const hours24 = 24 * 60 * 60 * 1000;

  const pad = (n) => (n < 10 ? `0${n}` : `${n}`);
  let hours = dt.getHours();
  const minutes = pad(dt.getMinutes());
  const ampm = hours >= 12 ? 'pm' : 'am';
  hours = hours % 12;
  if (hours === 0) hours = 12;
  const timeLabel = `${pad(hours)}:${minutes}${ampm}`;

  if (diffMs >= hours24) {
    const day = pad(dt.getDate());
    const month = pad(dt.getMonth() + 1);
    const year = dt.getFullYear();
    const dateLabel = `${day}/${month}/${year}`;
    return { timeLabel, dateLabel };
  }
  return { timeLabel };
};


export const formatMessageTime = (date) => {
  const dt = new Date(date);
  const pad = (n) => (n < 10 ? `0${n}` : `${n}`);
  let hours = dt.getHours();
  const minutes = pad(dt.getMinutes());
  const ampm = hours >= 12 ? 'pm' : 'am';
  hours = hours % 12;
  if (hours === 0) hours = 12;
  return `${pad(hours)}:${minutes}${ampm}`;
};