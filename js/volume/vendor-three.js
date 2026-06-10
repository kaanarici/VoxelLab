import { THREE_MODULE_URL } from '../core/dependencies.js';

const THREE = await import(THREE_MODULE_URL);

export default THREE;
export const BackSide = THREE.BackSide;
export const BoxGeometry = THREE.BoxGeometry;
export const Data3DTexture = THREE.Data3DTexture;
export const DataTexture = THREE.DataTexture;
export const FloatType = THREE.FloatType;
export const GLSL3 = THREE.GLSL3;
export const LinearFilter = THREE.LinearFilter;
export const Matrix4 = THREE.Matrix4;
export const Mesh = THREE.Mesh;
export const NearestFilter = THREE.NearestFilter;
export const OrthographicCamera = THREE.OrthographicCamera;
export const PerspectiveCamera = THREE.PerspectiveCamera;
export const PlaneGeometry = THREE.PlaneGeometry;
export const RGBAFormat = THREE.RGBAFormat;
export const RawShaderMaterial = THREE.RawShaderMaterial;
export const Raycaster = THREE.Raycaster;
export const RedFormat = THREE.RedFormat;
export const Scene = THREE.Scene;
export const ShaderMaterial = THREE.ShaderMaterial;
export const UnsignedByteType = THREE.UnsignedByteType;
export const Vector2 = THREE.Vector2;
export const Vector3 = THREE.Vector3;
export const WebGLRenderer = THREE.WebGLRenderer;
