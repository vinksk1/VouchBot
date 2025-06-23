function generateVouchId() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function generateStars(points) {
  const flooredRating = Math.floor(Math.max(0, Math.min(5, points / 100)));
  return '★'.repeat(flooredRating) + '☆'.repeat(5 - flooredRating);
}

function calculateRating(totalPoints, count) {
  if (count === 0) return 0;
  const maxPoints = Math.min(100, count) * 5;
  return ((totalPoints / maxPoints) * 5).toFixed(2);
}

module.exports = { generateVouchId, generateStars, calculateRating };