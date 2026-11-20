// Exercise icons: part of the app, like its logo, so they are not in backups.
//
// ICONS: every icon has a stable key; its picture is icons/exercises/<key>.png
// (120 x 120 px, transparent; shown at 40 pt). Keys never change.
//
// ICON_BY_EXERCISE: which icon each exercise shows, by the exercise's internal id.
// Ids never change, so renaming an exercise keeps its icon. An exercise that is not
// listed (for example one added later on the phone) simply shows no icon.
// Only exercise ids and icon keys belong here: never plans, sets, reps or weights.
//
// Adding an icon: put the PNG in icons/exercises/, add its key to ICONS, add it to
// FILES in sw.js (so it works offline), then map exercises to it below.

export const ICONS = [
  'back-extension',
  'cable-triceps-pushdown',
  'chest-press',
  'deadlift',
  'decline-bench-press',
  'decline-crunches',
  'dips',
  'dumbbell-biceps-curl',
  'face-pull',
  'lateral-raises',
  'leg-curl',
  'leg-press',
  'lying-dumbbell-triceps-extension',
  'machine-biceps-curl',
  'pull-ups',
  'rear-delt-fly',
  'seated-cable-row',
  'shoulder-press',
  'squat',
  'total-abdominal'
];

export const ICON_BY_EXERCISE = {
  incline_bench: 'decline-bench-press',          // Decline Bench Press
  incline_crunch: 'decline-crunches',            // Decline Crunches
  shoulder_press: 'shoulder-press',              // Shoulder Press
  squat: 'squat',                                // Squat
  tri_pushdown: 'cable-triceps-pushdown',        // Cable Triceps Pushdown
  back_ext: 'back-extension',                    // Back Extension
  face_pull: 'face-pull',                        // Face Pull
  pullups: 'pull-ups',                           // Pull-ups
  machine_curl: 'machine-biceps-curl',           // Machine Biceps Curl
  rear_delt: 'rear-delt-fly',                    // Rear Delt Fly
  dips: 'dips',                                  // Dips
  leg_press: 'leg-press',                        // Leg Press
  lat_raise: 'lateral-raises',                   // Lateral Raises
  deadlift: 'deadlift',                          // Deadlift
  cable_row: 'seated-cable-row',                 // Seated Cable Row
  total_abs: 'total-abdominal',                  // Total Abdominal
  db_tri_ext: 'lying-dumbbell-triceps-extension', // Lying Dumbbell Triceps Extension
  db_curl: 'dumbbell-biceps-curl',               // Dumbbell Biceps Curl
  leg_curl: 'leg-curl',                          // Leg Curl
  chest_press: 'chest-press'                     // Chest Press
};

const KNOWN = new Set(ICONS);

// Address of the exercise's icon, or null when it has none.
export function exerciseIconSrc(exerciseId) {
  const key = Object.prototype.hasOwnProperty.call(ICON_BY_EXERCISE, exerciseId) ? ICON_BY_EXERCISE[exerciseId] : null;
  return key && KNOWN.has(key) ? './icons/exercises/' + key + '.png' : null;
}
