import * as SecureStore from 'expo-secure-store';

const KEY = 'rootaru_signup_progress';

const STEP_TO_ROUTE = {
  name: 'SignupStepName',
  birthday: 'SignupStepBirthday',
  phone: 'SignupStepPhone',
  avatar: 'SignupStepAvatar',
  household: 'HouseholdSetup',
  address: 'SignupStepAddress',
  verify: 'EmailVerification',
  invite: 'InviteMembers',
  // The post-invite feature overview (household creators only). Listed here
  // so an in-session resume reopens the step the user was on rather than
  // failing to map — see FeatureTourShell for why a re-login skips the tour.
  feature1: 'FeatureIntro',
  feature2: 'FeatureDay',
  feature3: 'FeaturePrivacy',
  feature4: 'FeaturePricing',
};

export function stepToRoute(step, authMethod) {
  if (step === 'done') return 'InviteMembers';
  if (step === 'verify' && authMethod === 'phone') return 'PhoneVerification';
  if (step === 'verify' && authMethod === 'google') return 'InviteMembers';
  return STEP_TO_ROUTE[step];
}

export async function saveSignupProgress(progress) {
  await SecureStore.setItemAsync(KEY, JSON.stringify(progress));
}

export async function loadSignupProgress() {
  const raw = await SecureStore.getItemAsync(KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function clearSignupProgress() {
  await SecureStore.deleteItemAsync(KEY);
}

export async function updateSignupProgress(patch) {
  const current = (await loadSignupProgress()) || {
    authMethod: 'email',
    step: 'name',
    draft: {},
  };
  const next = {
    ...current,
    ...patch,
    draft: { ...current.draft, ...(patch.draft || {}) },
  };
  await saveSignupProgress(next);
  return next;
}
